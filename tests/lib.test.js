'use strict';

const assert = require('node:assert/strict');
const http = require('../server/lib/http');
const store = require('../server/lib/store');
const cw = require('../server/lib/connectwise');
const { fakeDb, fakeBackends, makeEnv, httpError, ticket, STATUSES } = require('./helpers');

test('parse handles empty, JSON, objects, and plain text', () => {
  assert.equal(http.parse(''), null);
  assert.equal(http.parse(undefined), null);
  assert.deepEqual(http.parse('{"a":1}'), { a: 1 });
  assert.deepEqual(http.parse({ a: 1 }), { a: 1 });
  assert.equal(http.parse('OK'), 'OK');
});

test('describeError formats HTTP and plain errors', () => {
  assert.equal(http.describeError(null), 'unknown error');
  assert.equal(http.describeError({ status: 500, response: 'boom' }), 'HTTP 500: boom');
  assert.equal(http.describeError({ status: 400, response: { e: 1 } }), 'HTTP 400: {"e":1}');
  assert.equal(http.describeError({ status: 400, message: 'bad' }), 'HTTP 400: "bad"');
  assert.equal(http.describeError(new Error('x')), 'x');
  assert.equal(http.describeError('str'), 'str');
});

test('store wraps $db and passes through non-404 errors', async () => {
  const env = { db: fakeDb() };
  await store.set(env, 'k', { v: 1 });
  assert.deepEqual(await store.get(env, 'k'), { v: 1 });
  assert.equal(await store.get(env, 'missing'), null);

  const broken = { db: { get: async () => { throw { status: 502 }; } } };
  await assert.rejects(store.get(broken, 'k'), (e) => e.status === 502);
});

test('ConnectWise token is cached until near expiry', async () => {
  const b = fakeBackends();
  const env = makeEnv(b);
  assert.equal(await cw.getToken(env), 'tok');
  assert.equal(await cw.getToken(env), 'tok');
  assert.equal(b.calls.filter((c) => c === 'cwToken').length, 1);

  await env.db.set('cw_token', { token: 'old', expiresAt: Date.now() + 1000 });
  await cw.getToken(env);
  assert.equal(b.calls.filter((c) => c === 'cwToken').length, 2);
});

test('ConnectWise token response without access_token is an error', async () => {
  const env = makeEnv({ request: { invokeTemplate: async () => ({ response: '{"error":"x"}' }) } });
  await assert.rejects(cw.getToken(env), /did not include access_token/);
});

test('listTickets excludes Closed-category statuses and pages by totalCount', async () => {
  const sent = [];
  const env = makeEnv({
    request: {
      invokeTemplate: async (name, { context }) => {
        sent.push({ name, context });
        if (name === 'cwToken') return { response: '{"access_token":"t"}' };
        if (name === 'cwStatuses') return { response: JSON.stringify(STATUSES) };
        return { response: JSON.stringify({ tickets: [{ id: 'a' }, { id: 'b' }], totalCount: 5 }) };
      }
    }
  });
  const first = await cw.listTickets(env, { updatedSince: '2026-10-16T10:00:00Z', page: 1, pageSize: 2 });
  assert.equal(first.tickets.length, 2);
  assert.equal(first.hasMore, true);
  const list = sent.find((c) => c.name === 'cwListTickets').context;
  assert.equal(list.statusIds, '[notIn],s-resolved,s-closed,s-archived');
  assert.equal(list.updatedAtFrom, '2026-10-16T10:00:00Z');
  assert.equal(list.pageNum, '1');
  const last = await cw.listTickets(env, { page: 3, pageSize: 2 });
  assert.equal(last.hasMore, false);
  assert.equal(sent.filter((c) => c.name === 'cwStatuses').length, 1);
});

test('statuses: closes to the active "Closed" status, else the first active Closed-category one', () => {
  assert.deepEqual(cw.summarizeStatuses(STATUSES).closeTo, { id: 's-closed', name: 'Closed' });
  const noClosedName = STATUSES.filter((s) => s.name !== 'Closed');
  assert.deepEqual(cw.summarizeStatuses(noClosedName).closeTo, { id: 's-resolved', name: 'Resolved' });
  const onlyInactive = STATUSES.filter((s) => s.category !== 'Closed' || s.inactiveFlag);
  assert.deepEqual(cw.summarizeStatuses(onlyInactive).closeTo, { id: 's-archived', name: 'Archived' });
  assert.throws(() => cw.summarizeStatuses([]), /no statuses in the Closed category/);
});

test('statuses are cached in $db for an hour', async () => {
  const b = fakeBackends();
  const env = makeEnv(b);
  await cw.getStatuses(env);
  await cw.getStatuses({ ...env, cache: {} });
  assert.equal(b.calls.filter((c) => c === 'cwStatuses').length, 1);
  await env.db.set('cw_statuses', { ...(await env.db.get('cw_statuses')), fetchedAt: Date.now() - 2 * 3600 * 1000 });
  await cw.getStatuses({ ...env, cache: {} });
  assert.equal(b.calls.filter((c) => c === 'cwStatuses').length, 2);
});

test('closeTicket sends a JSON Patch replacing the status', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b);
  const sent = [];
  const invoke = b.request.invokeTemplate;
  b.request.invokeTemplate = async (name, opts) => {
    if (name === 'cwUpdateTicket') sent.push(JSON.parse(opts.body));
    return invoke(name, opts);
  };
  await cw.closeTicket(env, '1');
  assert.deepEqual(sent, [[{ op: 'replace', path: '/status', value: { id: 's-closed', name: 'Closed' } }]]);
  assert.equal(b.cw.get('1').status.name, 'Closed');
});

test('isClosed uses status ids, falling back to names', async () => {
  const env = makeEnv(fakeBackends());
  assert.equal(await cw.isClosed(env, { statusId: 's-resolved', status: 'Resolved' }), true);
  assert.equal(await cw.isClosed(env, { statusId: 's-open', status: 'Open' }), false);
  assert.equal(await cw.isClosed(env, { status: 'Closed' }), true);
});

test('company names are looked up once, cached, and skipped when not permitted', async () => {
  const b = fakeBackends();
  const env = makeEnv(b);
  assert.equal(await cw.getCompanyName(env, undefined), undefined);
  assert.equal(await cw.getCompanyName(env, 'c-1'), 'Acme Corp');
  assert.equal(await cw.getCompanyName(env, 'c-1'), 'Acme Corp');
  assert.equal(b.calls.filter((c) => c === 'cwGetCompany').length, 1);

  b.failures.cwGetCompany = httpError(403, 'insufficient scope');
  assert.equal(await cw.getCompanyName(env, 'c-2'), undefined);
  assert.equal(await cw.getCompanyName(env, 'c-3'), undefined);
  assert.equal(b.calls.filter((c) => c === 'cwGetCompany').length, 2);
});

test('getTicket and closeTicket treat 404 as gone but rethrow other errors', async () => {
  const b = fakeBackends();
  const env = makeEnv(b);
  assert.equal(await cw.getTicket(env, 'missing'), null);
  await cw.closeTicket(env, 'missing');

  b.failures.cwGetTicket = httpError(500);
  await assert.rejects(cw.getTicket(env, 'x'), (e) => e.status === 500);
  b.failures.cwUpdateTicket = httpError(403);
  await assert.rejects(cw.closeTicket(env, 'x'), (e) => e.status === 403);
});

test('Freshservice create without an id in the response is an error', async () => {
  const fs = require('../server/lib/freshservice');
  const env = makeEnv({ request: { invokeTemplate: async () => ({ response: '{}' }) } });
  await assert.rejects(fs.createTicket(env, {}), /did not include ticket.id/);
  await fs.resolveTicket(env, 1);
});
