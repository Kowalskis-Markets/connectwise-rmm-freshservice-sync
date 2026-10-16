'use strict';

// server.js runs the way the FDK runtime runs it: in a vm context whose globals are the platform
// APIs ($request, $db, $schedule, renderData, generateTargetUrl), a console without warn(), and
// a require() that evaluates local files wrapped in `var exports = {}` with no `module` object.

const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeBackends, fakeDb, ticket, httpError } = require('./helpers');

const SERVER_FILE = path.join(__dirname, '..', 'server', 'server.js');
const silent = { log() {}, info() {}, error() {} }; // the FDK sandbox console has no warn()
// Objects created inside the sandbox have a different Object prototype; compare them as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const IPARAMS = {
  cw_client_id: 'id',
  cw_client_secret: 'secret',
  cw_scope: 'scope',
  default_requester_email: 'noc@example.com',
  poll_interval_minutes: '15'
};

function loadServer({ cwTickets = [], schedule = {} } = {}) {
  const backends = fakeBackends({ cwTickets });
  const db = fakeDb();
  const calls = { renderData: [], schedule: [] };
  const sandbox = {
    console: silent,
    exports: {},
    $request: backends.request,
    $db: db,
    $schedule: {
      create: async (s) => (schedule.create || (() => calls.schedule.push(['create', s])))(s),
      update: async (s) => (schedule.update || (() => calls.schedule.push(['update', s])))(s),
      delete: async (s) => (schedule.delete || (() => calls.schedule.push(['delete', s])))(s)
    },
    generateTargetUrl: async () => 'https://hooks.example.com/abc123',
    renderData: (arg) => calls.renderData.push(arg)
  };
  const context = vm.createContext(sandbox);
  sandbox.require = fdkRequire(context);
  vm.runInContext(nodeFs.readFileSync(SERVER_FILE, 'utf8'), context, { filename: SERVER_FILE });
  return { handlers: sandbox.exports, backends, db, calls };
}

// Mirrors the FDK sandbox require: relative paths resolve against the requiring file's directory.
function fdkRequire(context) {
  const dirs = [path.dirname(SERVER_FILE)];
  const cache = {};
  return (id) => {
    if (!id.startsWith('.')) return require(id);
    const file = path.resolve(dirs[dirs.length - 1], `${id}.js`);
    if (!cache[file]) {
      const src = `(function() {var exports = {};\n${nodeFs.readFileSync(file, 'utf8')};\nreturn exports;\n})()`;
      dirs.push(path.dirname(file));
      try {
        // Not named after the real file: the wrapper shifts offsets, which would garble coverage.
        cache[file] = vm.runInContext(src, context, { filename: `fdk-sandbox:${file}` });
      } finally {
        dirs.pop();
      }
    }
    return cache[file];
  };
}

test('install verifies access and schedules polling', async () => {
  const { handlers, backends, db, calls } = loadServer();

  await handlers.onAppInstallHandler({ iparams: IPARAMS });

  assert.deepEqual(calls.renderData, [undefined]);
  assert.equal(calls.schedule[0][0], 'create');
  assert.equal(calls.schedule[0][1].name, 'cw_poll');
  assert.deepEqual(plain(calls.schedule[0][1].repeat), { time_unit: 'minutes', frequency: 15 });
  assert.deepEqual(await db.get('cw_schedule'), { frequency: 15 });
  assert.equal(backends.fs.size, 0);
  assert.ok(backends.calls.includes('cwListTickets'));
});

test('install is blocked when ConnectWise credentials fail', async () => {
  const { handlers, backends, calls } = loadServer();
  backends.failures.cwToken = httpError(401, 'invalid_client');

  await handlers.onAppInstallHandler({ iparams: IPARAMS });

  assert.equal(calls.renderData.length, 1);
  assert.match(calls.renderData[0].message, /ConnectWise RMM.*401/);
  assert.equal(calls.schedule.length, 0);
});

test('install is blocked when Freshservice is unreachable', async () => {
  const { handlers, backends, calls } = loadServer();
  backends.failures.fsListTickets = httpError(401, 'bad key');

  await handlers.onAppInstallHandler({ iparams: IPARAMS });

  assert.match(calls.renderData[0].message, /Freshservice/);
});

test('install is blocked when ConnectWise tickets cannot be read', async () => {
  const { handlers, backends, calls } = loadServer();
  backends.failures.cwListTickets = httpError(403, 'insufficient scope');

  await handlers.onAppInstallHandler({ iparams: IPARAMS });

  assert.match(calls.renderData[0].message, /Could not read ConnectWise RMM tickets.*403/);
  assert.equal(calls.schedule.length, 0);
});

test('install updates an existing schedule and clamps the interval to 5 minutes', async () => {
  const { handlers, calls } = loadServer({
    schedule: {
      create: () => {
        throw { status: 409, message: 'already exists' };
      }
    }
  });

  await handlers.onAppInstallHandler({ iparams: { ...IPARAMS, poll_interval_minutes: '1' } });

  assert.equal(calls.schedule[0][0], 'update');
  assert.equal(calls.schedule[0][1].repeat.frequency, 5);
  assert.deepEqual(calls.renderData, [undefined]);
});

test('uninstall deletes the schedule, and tolerates it already being gone', async () => {
  const ok = loadServer();
  await ok.handlers.onAppUninstallHandler({});
  assert.deepEqual(plain(ok.calls.schedule), [['delete', { name: 'cw_poll' }]]);
  assert.deepEqual(ok.calls.renderData, [undefined]);

  const gone = loadServer({
    schedule: {
      delete: () => {
        throw { status: 404 };
      }
    }
  });
  await gone.handlers.onAppUninstallHandler({});
  assert.deepEqual(gone.calls.renderData, [undefined]);
});

test('scheduled event imports tickets and never throws', async () => {
  const { handlers, backends } = loadServer({ cwTickets: [ticket(1)] });

  await handlers.onScheduledEventHandler({ iparams: IPARAMS });
  assert.equal(backends.fs.size, 1);
  assert.equal(backends.cw.get('1').status.name, 'Closed');

  backends.failures.cwListTickets = httpError(500, 'down');
  await handlers.onScheduledEventHandler({ iparams: IPARAMS });
});

test('a changed poll interval is applied on the next poll, and only then', async () => {
  const { handlers, db, calls } = loadServer();
  await handlers.onAppInstallHandler({ iparams: IPARAMS });

  await handlers.onScheduledEventHandler({ iparams: IPARAMS });
  assert.equal(calls.schedule.length, 1);

  await handlers.onScheduledEventHandler({ iparams: { ...IPARAMS, poll_interval_minutes: '30' } });
  assert.equal(calls.schedule[1][0], 'update');
  assert.equal(calls.schedule[1][1].repeat.frequency, 30);
  assert.deepEqual(await db.get('cw_schedule'), { frequency: 30 });

  await handlers.onScheduledEventHandler({ iparams: { ...IPARAMS, poll_interval_minutes: '30' } });
  assert.equal(calls.schedule.length, 2);
});

test('a failed interval update does not stop the poll', async () => {
  const { handlers, backends } = loadServer({ cwTickets: [ticket(1)], schedule: { update: () => { throw new Error('nope'); } } });
  await handlers.onScheduledEventHandler({ iparams: IPARAMS });
  assert.equal(backends.fs.size, 1);
});

test('external event resolves the mapped ticket and never throws', async () => {
  const { handlers, backends } = loadServer({ cwTickets: [ticket(5)] });
  await handlers.onScheduledEventHandler({ iparams: { ...IPARAMS, close_after_import: false } });

  backends.failures.fsUpdateTicket = httpError(500, 'boom');
  await handlers.onExternalEventHandler({ iparams: IPARAMS, data: { action: 'Close', ticketId: '5' }, headers: {} });
  const [fsTicket] = backends.fs.values();
  assert.equal(fsTicket.status, 2);

  await handlers.onExternalEventHandler({ iparams: IPARAMS, data: { action: 'Close', ticketId: '5' }, headers: {} });
  assert.equal(fsTicket.status, 4);
});
