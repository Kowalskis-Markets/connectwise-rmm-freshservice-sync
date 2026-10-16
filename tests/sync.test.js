'use strict';

const assert = require('node:assert/strict');
const sync = require('../server/lib/sync');
const store = require('../server/lib/store');
const { fakeBackends, makeEnv, ticket, httpError } = require('./helpers');

test('imports open tickets and closes them in ConnectWise by default', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2), ticket(3, { status: 'Closed' })] });
  const env = makeEnv(b);

  const result = await sync.poll(env);

  assert.equal(result.imported, 2);
  assert.equal(result.closed, 2);
  assert.equal(b.fs.size, 2);
  assert.deepEqual([...b.cw.values()].map((t) => t.status.name), ['Closed', 'Closed', 'Closed']);
  assert.equal(b.cw.size, 3);
  const m = await store.getMapping(env, '1');
  assert.equal(m.closedBySync, true);
  assert.equal(b.fs.get(m.fsId).status, 2);
  assert.ok(await store.getCursor(env, 'import'));
});

test('re-reads the first page while closing so no tickets are skipped', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ticket(i + 1));
  const b = fakeBackends({ cwTickets: many });
  const env = makeEnv(b);

  const result = await sync.poll(env);

  assert.equal(result.imported, 120);
  assert.equal([...b.cw.values()].filter((t) => t.status.name === 'Open').length, 0);
});

test('leaves ConnectWise tickets open when close_after_import is off', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2)] });
  const env = makeEnv(b, { close_after_import: false });

  await sync.poll(env);

  assert.deepEqual([...b.cw.values()].map((t) => t.status.name), ['Open', 'Open']);
  assert.equal(b.calls.includes('cwUpdateTicket'), false);
});

test('polling twice never imports a ticket twice', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b, { close_after_import: 'false' });

  await sync.poll(env);
  const second = await sync.poll(env);

  assert.equal(second.imported, 0);
  assert.equal(b.fs.size, 1);
});

test('a failed close is retried on the next poll without re-importing', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b);
  b.failures.cwUpdateTicket = httpError(500, 'boom');

  const first = await sync.poll(env);
  assert.equal(first.imported, 1);
  assert.equal(first.closed, 0);
  assert.equal(first.errors.length, 1);
  assert.equal((await store.getMapping(env, '1')).closedBySync, false);

  const second = await sync.poll(env);
  assert.equal(second.imported, 0);
  assert.equal(second.closed, 1);
  assert.equal(b.fs.size, 1);
  assert.equal(b.cw.get('1').status.name, 'Closed');
});

test('the resolve pass does not resolve tickets the sync closed itself', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b);

  await sync.poll(env);
  const second = await sync.poll(env);

  assert.equal(b.cw.get('1').status.name, 'Closed');
  assert.equal(second.resolved, 0);
  const m = await store.getMapping(env, '1');
  assert.equal(b.fs.get(m.fsId).status, 2);
  assert.equal(b.calls.includes('fsUpdateTicket'), false);
});

test('poll resolves Freshservice tickets whose ConnectWise ticket was resolved', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2)] });
  const env = makeEnv(b, { close_after_import: false });
  await sync.poll(env);

  b.setStatus('1', 'Resolved');
  const result = await sync.poll(env);

  assert.equal(result.resolved, 1);
  const fsId = (await store.getMapping(env, '1')).fsId;
  assert.equal(b.fs.get(fsId).status, 4);
  assert.equal(b.notes.length, 1);
  assert.match(b.notes[0].body, /ticket 5001/);
  assert.equal(b.fs.get((await store.getMapping(env, '2')).fsId).status, 2);

  const again = await sync.poll(env);
  assert.equal(again.resolved, 0);
  assert.equal(b.notes.length, 1);
});

test('poll does not resolve when resolve_sync is off', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b, { close_after_import: false, resolve_sync: false });
  await sync.poll(env);
  b.setStatus('1', 'Closed');

  const result = await sync.poll(env);

  assert.equal(result.resolved, 0);
  assert.equal(b.calls.includes('fsUpdateTicket'), false);
});

test('a 429 stops the run without throwing, and the next run continues', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b);
  b.failures.cwListTickets = { status: 429, headers: { 'retry-after': '30' }, response: '' };

  const first = await sync.poll(env);
  assert.match(first.stopped, /Rate limited/);
  assert.equal(first.imported, 0);

  const second = await sync.poll(env);
  assert.equal(second.imported, 1);
});

test('expired ConnectWise token is refreshed on 401', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1)] });
  const env = makeEnv(b);
  b.failures.cwListTickets = httpError(401);

  const result = await sync.poll(env);

  assert.equal(result.imported, 1);
  assert.equal(b.calls.filter((c) => c === 'cwToken').length, 2);
});

test('cursor is not advanced past a ticket that failed to import', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2)] });
  const env = makeEnv(b);
  b.failures.fsCreateTicket = httpError(500, 'boom');

  const first = await sync.poll(env);
  assert.equal(first.imported, 1);
  assert.equal(first.errors.length, 1);
  assert.equal(await store.getCursor(env, 'import'), null);

  // Ticket 1 failed first time round (ticket 2 was imported and closed), so ticket 1 is
  // imported now and the cursor finally moves.
  const second = await sync.poll(env);
  assert.equal(second.imported, 1);
  assert.equal(b.fs.size, 2);
  assert.equal(await store.getCursor(env, 'import'), ticket(1).updatedAt);
});

test('stops starting new work once the time budget is spent', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2)] });
  const env = makeEnv(b, { close_after_import: false });
  const realNow = Date.now;
  const invoke = b.request.invokeTemplate;
  let offset = 0;
  Date.now = () => realNow() + offset;
  // Creating the first Freshservice ticket uses up the whole time budget.
  b.request.invokeTemplate = async (name, opts) => {
    const res = await invoke(name, opts);
    if (name === 'fsCreateTicket') offset = sync.TIME_BUDGET_MS + 1;
    return res;
  };
  try {
    const result = await sync.poll(env);
    assert.equal(result.imported, 1);
  } finally {
    Date.now = realNow;
  }
  // Progress is kept: the next poll starts after ticket 1.
  assert.equal(await store.getCursor(env, 'import'), ticket(1).updatedAt);
});

test('a ticket that failed to close is retried after newer tickets are imported', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2), ticket(3)] });
  const env = makeEnv(b);
  b.failures.cwUpdateTicket = httpError(500, 'boom');

  const first = await sync.poll(env);
  assert.equal(first.imported, 3);
  assert.equal(first.closed, 2);
  assert.match(first.errors[0], /CW 5001: imported, but closing in ConnectWise failed: HTTP 500/);

  const second = await sync.poll(env);
  assert.equal(second.imported, 0);
  assert.equal(second.closed, 1);
  assert.equal(b.cw.get('1').status.name, 'Closed');
  assert.equal(b.fs.size, 3);
});

test('tickets updated mid-scan are not skipped by paging', async () => {
  const b = fakeBackends({ cwTickets: Array.from({ length: 120 }, (_, i) => ticket(i + 1)) });
  const env = makeEnv(b, { close_after_import: false });
  const invoke = b.request.invokeTemplate;
  let bumped = false;
  // While page 1 is processed, ticket 1 is updated in ConnectWise and moves to the end of the order.
  b.request.invokeTemplate = async (name, opts) => {
    const res = await invoke(name, opts);
    if (name === 'fsCreateTicket' && !bumped) {
      bumped = true;
      b.setStatus('1', 'Open');
    }
    return res;
  };

  const result = await sync.poll(env);

  assert.equal(result.imported, 120);
  assert.equal(b.fs.size, 120);
});

test('a backlog larger than one poll is worked through across polls', async () => {
  const b = fakeBackends({ cwTickets: Array.from({ length: 25 }, (_, i) => ticket(i + 1)) });
  const env = makeEnv(b, { close_after_import: false });
  const realNow = Date.now;
  const invoke = b.request.invokeTemplate;
  let offset = 0;
  let creates = 0;
  Date.now = () => realNow() + offset;
  // Each poll runs out of time after 10 Freshservice creates.
  b.request.invokeTemplate = async (name, opts) => {
    const res = await invoke(name, opts);
    if (name === 'fsCreateTicket' && ++creates % 10 === 0) offset = sync.TIME_BUDGET_MS + 1;
    return res;
  };
  try {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      offset = 0;
      counts.push((await sync.poll(env)).imported);
    }
    assert.deepEqual(counts, [10, 10, 5]);
  } finally {
    Date.now = realNow;
  }
  assert.equal(b.fs.size, 25);
});

test('the resolve pass keeps its place after a transient error and stops on a 429', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1), ticket(2)] });
  const env = makeEnv(b, { close_after_import: false });
  await sync.poll(env);
  b.setStatus('1', 'Closed');

  b.failures.fsUpdateTicket = httpError(500, 'flaky');
  const flaky = await sync.poll(env);
  assert.equal(flaky.resolved, 0);
  assert.equal(flaky.errors.length, 1);

  b.failures.cwListTickets = { status: 429, headers: { 'retry-after': '5' }, response: '' };
  const limited = await sync.poll(env);
  assert.equal(limited.stopped, 'Rate limited; retry after 5s');

  const retried = await sync.poll(env);
  assert.equal(retried.resolved, 1);
});

test('the resolve pass ignores tickets that were closed before it first ran', async () => {
  const b = fakeBackends({ cwTickets: [ticket(1, { status: 'Closed' })] });
  const env = makeEnv(b);
  await env.db.set('cw:1', { fsId: 1, status: 'open', closedBySync: false });
  b.fs.set(1, { id: 1, status: 2 });

  const result = await sync.poll(env);

  assert.equal(result.resolved, 0);
  assert.ok(await store.getCursor(env, 'resolve'));
});

test('resolve still succeeds when the note cannot be added', async () => {
  const b = fakeBackends({ cwTickets: [ticket(4)] });
  const env = makeEnv(b, { close_after_import: false });
  await sync.poll(env);
  b.failures.fsAddNote = httpError(500, 'notes down');
  b.setStatus('4', 'Closed');

  const result = await sync.poll(env);

  assert.equal(result.resolved, 1);
  assert.equal(b.fs.get((await store.getMapping(env, '4')).fsId).status, 4);
  assert.equal(b.notes.length, 0);
});

test('checkConnections reports which side failed', async () => {
  const b = fakeBackends();
  const env = makeEnv(b);
  await sync.checkConnections(env);

  b.failures.cwToken = httpError(401, 'nope');
  await assert.rejects(sync.checkConnections(env), /ConnectWise RMM: HTTP 401: nope/);

  b.failures.fsListTickets = new Error('ENOTFOUND');
  await assert.rejects(sync.checkConnections(env), /Freshservice: ENOTFOUND/);
});

test('flag reads booleans, strings, and defaults', () => {
  assert.equal(sync.flag(true, false), true);
  assert.equal(sync.flag('true', false), true);
  assert.equal(sync.flag(false, true), false);
  assert.equal(sync.flag('false', true), false);
  assert.equal(sync.flag(undefined, true), true);
  assert.equal(sync.flag('', false), false);
});
