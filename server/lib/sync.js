'use strict';

const cw = require('./connectwise');
const fs = require('./freshservice');
const store = require('./store');
const { toFreshservice, escapeHtml } = require('./mapping');
const { describeError } = require('./http');

// FDK serverless invocations are cut off at 20s; stop starting new work well before that.
const TIME_BUDGET_MS = 15000;
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
// The resolve pass starts this far before its first run, to cover clock skew with ConnectWise.
const RESOLVE_LOOKBACK_MS = 10 * 60 * 1000;

// Checkbox iparams may arrive as booleans or strings; unset means the default.
function flag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === true || value === 'true';
}

const settings = (env) => ({
  closeAfterImport: flag(env.iparams.close_after_import, true),
  resolveSync: flag(env.iparams.resolve_sync, true)
});

class RateLimited extends Error {}

const isRateLimit = (err) => err instanceof RateLimited || (err && err.status === 429);

function asRateLimited(err) {
  if (err instanceof RateLimited) return err;
  const retryAfter = err.headers && (err.headers['retry-after'] || err.headers['Retry-After']);
  return new RateLimited(`Rate limited${retryAfter ? `; retry after ${retryAfter}s` : ''}`);
}

function rethrowIfRateLimited(err) {
  if (isRateLimit(err)) throw asRateLimited(err);
}

async function checkConnections(env) {
  try {
    await cw.getToken(env, { force: true });
  } catch (err) {
    throw new Error(`Could not authenticate with ConnectWise RMM: ${describeError(err)}`);
  }
  try {
    await cw.listTickets(env, { page: 1, pageSize: 1 });
  } catch (err) {
    throw new Error(`Could not read ConnectWise RMM tickets (check the Tickets Read scope): ${describeError(err)}`);
  }
  try {
    await fs.ping(env);
  } catch (err) {
    throw new Error(`Could not reach Freshservice: ${describeError(err)}`);
  }
}

// Closing a ticket may make ConnectWise report a close event. The mapping is marked closedBySync
// before the update so that event is ignored instead of resolving the Freshservice ticket just created.
// A failed close throws, so the scan cursor stops there and the close is retried next poll.
async function closeInConnectWise(env, cwId, mapping, result) {
  await store.setMapping(env, cwId, { ...mapping, closedBySync: true });
  try {
    await cw.closeTicket(env, cwId);
  } catch (err) {
    await store.setMapping(env, cwId, mapping);
    rethrowIfRateLimited(err);
    throw new Error(`imported, but closing in ConnectWise failed: ${describeError(err)}`);
  }
  result.closed++;
}

// Creates the Freshservice ticket if needed, then closes the ConnectWise ticket if configured.
// The mapping is written before the close so a failed close is retried without re-importing.
async function importOne(env, ticket, result) {
  let mapping = await store.getMapping(env, ticket.id);

  if (!mapping) {
    if (await cw.isClosed(env, ticket)) return;
    const company = await cw.getCompanyName(env, ticket.companyId);
    const fsId = await fs.createTicket(env, toFreshservice({ ...ticket, company }, env.iparams));
    mapping = { fsId, number: ticket.number, status: 'open', closedBySync: false, importedAt: new Date().toISOString() };
    await store.setMapping(env, ticket.id, mapping);
    result.imported++;
    env.log.info(`Imported ConnectWise ticket ${ticket.number || ticket.id} as Freshservice ticket ${fsId}`);
  }

  if (settings(env).closeAfterImport && !mapping.closedBySync) await closeInConnectWise(env, ticket.id, mapping, result);
}

async function resolveInFreshservice(env, cwId, mapping, via, result) {
  const label = escapeHtml(mapping.number || cwId);
  const note = `<p>Resolved in ConnectWise RMM (ticket ${label}); synced by ${escapeHtml(via)}.</p>`;
  await fs.resolveTicket(env, mapping.fsId, note);
  await store.setMapping(env, cwId, { ...mapping, status: 'resolved', resolvedAt: new Date().toISOString() });
  if (result) result.resolved++;
  env.log.info(`Resolved Freshservice ticket ${mapping.fsId} (ConnectWise ${mapping.number || cwId}) via ${via}`);
}

// Resolves the Freshservice ticket for a ConnectWise ticket found in a Closed-category status.
async function resolveIfMapped(env, ticket, result) {
  const mapping = await store.getMapping(env, ticket.id);
  if (!mapping || mapping.status === 'resolved' || mapping.closedBySync) return;
  await resolveInFreshservice(env, ticket.id, mapping, 'poll', result);
}

const newer = (a, b) => (b && (!a || b > a) ? b : a);

// Handles one ticket. The cursor follows successfully handled tickets (they arrive oldest first) and
// freezes at the first failure, so that ticket is listed again next poll.
async function scanOne(env, ticket, state, result, handle) {
  try {
    await handle(ticket);
    if (!state.frozen) state.cursor = newer(state.cursor, ticket.updatedAt);
  } catch (err) {
    rethrowIfRateLimited(err);
    state.frozen = true;
    result.errors.push(`CW ${ticket.number || ticket.id}: ${describeError(err)}`);
  }
}

// Returns the newest updatedAt on the page, or null if time ran out before the page was finished.
async function scanPage(env, tickets, deadline, state, result, handle) {
  let last = null;
  for (const ticket of tickets) {
    if (Date.now() >= deadline) return null;
    await scanOne(env, ticket, state, result, handle);
    last = newer(last, ticket.updatedAt);
  }
  return last;
}

// Keyset paging: each request starts from the newest updatedAt seen so far, so tickets updated or
// closed mid-scan can't shift others out of view. Page numbers only advance within a single
// timestamp (more than a page of tickets updated at the same instant).
async function scanPages(env, closed, state, deadline, result, handle) {
  let from = state.cursor;
  let page = 1;
  for (let i = 0; i < MAX_PAGES && Date.now() < deadline; i++) {
    const { tickets, hasMore } = await cw.listTickets(env, { closed, updatedSince: from, page, pageSize: PAGE_SIZE });
    const last = await scanPage(env, tickets, deadline, state, result, handle);
    if (last === null || !hasMore) return;
    if (last > from || !from) {
      from = last;
      page = 1;
    } else {
      page++;
    }
  }
}

// Walks tickets oldest first from a stored cursor, calling handle for each, and saves the cursor
// even when the pass is cut short by the time budget or a rate limit.
async function scan(env, { name, closed, startAt }, deadline, result, handle) {
  const saved = await store.getCursor(env, name);
  const state = { cursor: saved || startAt || null, frozen: false };
  try {
    await scanPages(env, closed, state, deadline, result, handle);
  } finally {
    if (state.cursor && state.cursor !== saved) await store.setCursor(env, name, state.cursor);
  }
}

async function poll(env) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const result = { imported: 0, closed: 0, resolved: 0, errors: [], stopped: null };
  try {
    await scan(env, { name: 'import', closed: false }, deadline, result, (t) => importOne(env, t, result));
    if (settings(env).resolveSync) {
      const startAt = new Date(Date.now() - RESOLVE_LOOKBACK_MS).toISOString();
      await scan(env, { name: 'resolve', closed: true, startAt }, deadline, result, (t) => resolveIfMapped(env, t, result));
    }
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    result.stopped = asRateLimited(err).message;
  }
  return result;
}

function webhookAuthorized(env, data, headers) {
  const secret = env.iparams.webhook_secret;
  if (!secret) return true;
  const h = headers || {};
  const supplied = h['x-webhook-secret'] || h['X-Webhook-Secret'] || (data && data.secret);
  return supplied === secret;
}

async function handleResolvedEvent(env, cwId) {
  if (!settings(env).resolveSync) return { ignored: 'resolve sync disabled' };
  const mapping = await store.getMapping(env, cwId);
  if (!mapping) return { ignored: `unknown ticket ${cwId}` };
  if (mapping.closedBySync) return { ignored: 'closed by sync' };
  if (mapping.status === 'resolved') return { ignored: 'already resolved' };
  await resolveInFreshservice(env, cwId, mapping, 'webhook');
  return { resolved: cwId };
}

async function handleCreatedEvent(env, event) {
  const ticket = (await cw.getTicket(env, event.id)) || event.ticket;
  const result = { imported: 0, closed: 0, resolved: 0, errors: [] };
  await importOne(env, ticket, result);
  return { imported: result.imported, closed: result.closed, errors: result.errors };
}

async function handleWebhook(env, data, headers) {
  if (!webhookAuthorized(env, data, headers)) return { ignored: 'bad secret' };
  const event = cw.parseWebhook(data);
  if (!event.id) return { ignored: 'no ticket id' };
  if (event.resolved) return await handleResolvedEvent(env, event.id);
  if (event.created) return await handleCreatedEvent(env, event);
  return { ignored: 'unhandled event' };
}

Object.assign(exports, { checkConnections, poll, importOne, handleWebhook, flag, TIME_BUDGET_MS });
