'use strict';

// ConnectWise RMM (Asio) Platform API client, per the ConnectWise Platform APIs spec (v3.0.4).
// Every ConnectWise path lives in config/requests.json and every ConnectWise field name lives in
// this file, so API corrections stay in those two places.

const { invoke, describeError } = require('./http');
const store = require('./store');

const TOKEN_KEY = 'cw_token';
const TOKEN_SKEW_MS = 60 * 1000;
const STATUSES_KEY = 'cw_statuses';
const STATUSES_TTL_MS = 60 * 60 * 1000;
const CLOSED_CATEGORY = 'Closed';
const PREFERRED_CLOSE_STATUS = 'closed';
const EPOCH = '2000-01-01T00:00:00Z';
// Only used for webhook payloads, which may carry a status name rather than an id.
const RESOLVED_STATUS_NAMES = new Set(['resolved', 'closed', 'completed', 'complete', 'cancelled']);
const RESOLVE_ACTIONS = new Set(['close', 'closed', 'resolve', 'resolved', 'ticket.closed', 'ticket.resolved']);
const CREATE_ACTIONS = new Set(['create', 'created', 'ticket.created']);

async function cachedToken(env) {
  const cached = await store.get(env, TOKEN_KEY);
  const fresh = cached && cached.token && cached.expiresAt > Date.now() + TOKEN_SKEW_MS;
  return fresh ? cached.token : null;
}

async function requestToken(env) {
  const body = await invoke(env, 'cwToken', {}, {
    grant_type: 'client_credentials',
    client_id: env.iparams.cw_client_id,
    client_secret: env.iparams.cw_client_secret,
    scope: env.iparams.cw_scope
  });
  const token = body && body.access_token;
  if (!token) throw new Error('ConnectWise token response did not include access_token');
  const ttlSec = Number(body.expires_in) || 3600;
  await store.set(env, TOKEN_KEY, { token, expiresAt: Date.now() + ttlSec * 1000 });
  return token;
}

async function getToken(env, options) {
  const cached = options && options.force ? null : await cachedToken(env);
  return cached || requestToken(env);
}

// Calls a ConnectWise template with a bearer token, refreshing once on 401.
async function authed(env, template, context = {}, body) {
  const token = await getToken(env);
  try {
    return await invoke(env, template, { ...context, token }, body);
  } catch (err) {
    if (!err || err.status !== 401) throw err;
    const fresh = await getToken(env, { force: true });
    return invoke(env, template, { ...context, token: fresh }, body);
  }
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o === null || o === undefined ? undefined : o[part]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Per-invocation memo, so one poll fetches statuses and company names at most once.
function memo(env) {
  if (!env.cache) env.cache = {};
  return env.cache;
}

// Picks the status tickets are moved to when closed: an active Closed-category status named
// "Closed" if there is one, otherwise the first active Closed-category status.
function summarizeStatuses(rows) {
  const closed = (rows || []).filter((s) => s && s.category === CLOSED_CATEGORY);
  if (closed.length === 0) throw new Error('ConnectWise returned no statuses in the Closed category');
  const active = closed.filter((s) => !s.inactiveFlag);
  const closeTo =
    active.find((s) => String(s.name).toLowerCase() === PREFERRED_CLOSE_STATUS) || active[0] || closed[0];
  return { closedIds: closed.map((s) => s.id), closeTo: { id: closeTo.id, name: closeTo.name } };
}

async function getStatuses(env) {
  const cache = memo(env);
  if (cache.statuses) return cache.statuses;
  const stored = await store.get(env, STATUSES_KEY);
  if (stored && stored.fetchedAt > Date.now() - STATUSES_TTL_MS) {
    cache.statuses = stored;
    return stored;
  }
  const summary = summarizeStatuses(await authed(env, 'cwStatuses'));
  cache.statuses = { ...summary, fetchedAt: Date.now() };
  await store.set(env, STATUSES_KEY, cache.statuses);
  return cache.statuses;
}

const optionalString = (v) => (v === undefined ? undefined : String(v));

function normalize(raw) {
  const id = raw && typeof raw === 'object' ? pick(raw, 'id', 'ticketId') : undefined;
  if (id === undefined) return null;
  const number = optionalString(pick(raw, 'number', 'ticketNumber'));
  return {
    id: String(id),
    number,
    subject: pick(raw, 'summary') || `ConnectWise RMM ticket ${number || id}`,
    description: pick(raw, 'description') || '',
    priority: pick(raw, 'priority.name', 'priority'),
    statusId: pick(raw, 'status.id'),
    status: String(pick(raw, 'status.name', 'status') || ''),
    companyId: pick(raw, 'company.id'),
    siteId: pick(raw, 'site.id'),
    createdAt: pick(raw, 'createdAt'),
    updatedAt: pick(raw, 'updatedAt', 'createdAt')
  };
}

async function isClosed(env, ticket) {
  const { closedIds } = await getStatuses(env);
  if (ticket.statusId) return closedIds.includes(ticket.statusId);
  return RESOLVED_STATUS_NAMES.has(ticket.status.toLowerCase());
}

// Lists open tickets (or, with closed: true, tickets in a Closed-category status) updated at or
// after updatedSince, oldest first.
async function listTickets(env, { closed = false, updatedSince, page, pageSize }) {
  const { closedIds } = await getStatuses(env);
  const body = await authed(env, 'cwListTickets', {
    statusIds: closed ? closedIds.join(',') : `[notIn],${closedIds.join(',')}`,
    updatedAtFrom: updatedSince || EPOCH,
    pageNum: page,
    pageSize
  });
  const rows = (body && body.tickets) || [];
  return { tickets: rows.map(normalize).filter(Boolean), hasMore: hasMorePages(body, rows, page, pageSize) };
}

// Uses totalCount when present; otherwise a full page implies there may be more.
function hasMorePages(body, rows, page, pageSize) {
  const total = Number(body && body.totalCount);
  return Number.isFinite(total) ? page * pageSize < total : rows.length >= pageSize;
}

async function getTicket(env, id) {
  try {
    return normalize(await authed(env, 'cwGetTicket', { id }));
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

async function closeTicket(env, id) {
  const { closeTo } = await getStatuses(env);
  try {
    await authed(env, 'cwUpdateTicket', { id }, [{ op: 'replace', path: '/status', value: closeTo }]);
  } catch (err) {
    if (!err || err.status !== 404) throw err; // already gone needs no closing
  }
}

// Best effort: needs the platform.companies.read scope. Names are cached; failures just omit it.
async function getCompanyName(env, companyId) {
  const cache = memo(env);
  if (!companyId || cache.companiesUnavailable) return undefined;
  cache.companies = cache.companies || {};
  if (!(companyId in cache.companies)) cache.companies[companyId] = await lookupCompanyName(env, companyId);
  return cache.companies[companyId];
}

async function lookupCompanyName(env, companyId) {
  const key = `cw_company:${companyId}`;
  const stored = await store.get(env, key);
  if (stored) return stored.name;
  try {
    const body = await authed(env, 'cwGetCompany', { id: companyId });
    const name = pick(body || {}, 'friendlyName', 'name');
    if (name) await store.set(env, key, { name });
    return name;
  } catch (err) {
    memo(env).companiesUnavailable = true;
    env.log.info(`Company names unavailable (${describeError(err)}); add platform.companies.read to the scope to include them`);
    return undefined;
  }
}

// Interprets a webhook payload. The Platform API has no ticket webhooks; this handles anything
// that posts ticket events to the app's external event URL.
function parseWebhook(data) {
  const payload = data || {};
  const ticket = normalize(pick(payload, 'ticket', 'data.ticket', 'data')) || normalize(payload);
  if (!ticket) return { id: undefined, ticket: null, resolved: false, created: false };
  const action = String(pick(payload, 'action', 'event', 'eventType', 'type') || '').toLowerCase();
  return {
    id: ticket.id,
    ticket,
    resolved: RESOLVE_ACTIONS.has(action) || RESOLVED_STATUS_NAMES.has(ticket.status.toLowerCase()),
    created: CREATE_ACTIONS.has(action)
  };
}

Object.assign(exports, {
  getToken,
  getStatuses,
  listTickets,
  getTicket,
  closeTicket,
  getCompanyName,
  normalize,
  isClosed,
  parseWebhook,
  summarizeStatuses
});
