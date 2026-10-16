'use strict';

// In-memory stand-ins for the FDK $db and $request globals, with fake ConnectWise and Freshservice backends.

function fakeDb() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (!data.has(key)) throw { status: 404, message: 'Record not found' };
      return structuredClone(data.get(key));
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
      return { Created: true };
    },
    async delete(key) {
      if (!data.has(key)) throw { status: 404 };
      data.delete(key);
    }
  };
}

function httpError(status, response = '') {
  return { status, headers: {}, response };
}

// Ticket statuses as returned by /api/platform/v1/service/ticketing/statuses.
const STATUSES = [
  { id: 's-new', name: 'New', category: 'New', slaStatus: 'NotResponded' },
  { id: 's-open', name: 'Open', category: 'InProgress', slaStatus: 'Responded' },
  { id: 's-resolved', name: 'Resolved', category: 'Closed', slaStatus: 'Resolved' },
  { id: 's-closed', name: 'Closed', category: 'Closed', slaStatus: 'Resolved' },
  { id: 's-archived', name: 'Archived', category: 'Closed', slaStatus: 'Resolved', inactiveFlag: true }
];
const statusRef = (name) => {
  const s = STATUSES.find((x) => x.name === name);
  return { id: s.id, name: s.name };
};

function fakeBackends({ cwTickets = [], companies = { 'c-1': { id: 'c-1', name: 'Acme Corp' } } } = {}) {
  const cw = new Map(cwTickets.map((t) => [String(t.id), structuredClone(t)]));
  const fs = new Map();
  const notes = [];
  const calls = [];
  let nextFsId = 1000;
  const failures = {}; // template -> error to throw once
  // Like ConnectWise, a status change bumps updatedAt.
  const setStatus = (id, name) => {
    const t = cw.get(String(id));
    t.status = statusRef(name);
    t.updatedAt = new Date().toISOString();
  };

  const handlers = {
    cwToken: () => ({ access_token: 'tok', expires_in: 3600 }),
    cwStatuses: () => STATUSES,
    cwListTickets: ({ statusIds, updatedAtFrom, pageNum, pageSize }) => {
      const notIn = statusIds.startsWith('[notIn],');
      const ids = (notIn ? statusIds.slice(8) : statusIds).split(',');
      const matching = [...cw.values()]
        .filter((t) => ids.includes(t.status.id) !== notIn && t.updatedAt >= updatedAtFrom)
        .sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : 1));
      const start = (Number(pageNum) - 1) * Number(pageSize);
      const page = matching.slice(start, start + Number(pageSize));
      // Like the real API, a page past the end reports a total of 0.
      return { tickets: page, totalCount: page.length ? matching.length : 0 };
    },
    cwGetTicket: ({ id }) => {
      if (!cw.has(id)) throw httpError(404);
      return cw.get(id);
    },
    cwUpdateTicket: ({ id }, patch) => {
      if (!cw.has(id)) throw httpError(404);
      for (const op of patch) {
        if (op.op !== 'replace') throw httpError(405, 'Only replace operation is allowed');
        cw.get(id)[op.path.slice(1)] = op.value;
      }
      cw.get(id).updatedAt = new Date().toISOString();
      return cw.get(id);
    },
    cwGetCompany: ({ id }) => {
      if (!companies[id]) throw httpError(404);
      return companies[id];
    },
    fsListTickets: () => ({ tickets: [] }),
    fsCreateTicket: (_ctx, body) => {
      const id = nextFsId++;
      fs.set(id, { id, ...body });
      return { ticket: { id } };
    },
    fsUpdateTicket: ({ id }, body) => {
      const t = fs.get(Number(id));
      if (!t) throw httpError(404);
      Object.assign(t, body);
      return { ticket: t };
    },
    fsAddNote: ({ id }, body) => {
      notes.push({ id: Number(id), ...body });
      return { conversation: {} };
    }
  };

  const request = {
    async invokeTemplate(name, { context = {}, body } = {}) {
      calls.push(name);
      if (failures[name]) {
        const err = failures[name];
        delete failures[name];
        throw err;
      }
      const result = handlers[name](context, body === undefined ? undefined : JSON.parse(body));
      return { status: 200, headers: {}, response: typeof result === 'string' ? result : JSON.stringify(result) };
    }
  };

  return { cw, fs, notes, calls, failures, request, httpError, setStatus };
}

// Mirrors the FDK sandbox console, which has no warn().
const silentLog = { log() {}, info() {}, error() {} };

function makeEnv(backends, iparams = {}) {
  return {
    request: backends.request,
    db: fakeDb(),
    log: silentLog,
    iparams: {
      cw_client_id: 'id',
      cw_client_secret: 'secret',
      cw_scope: 'scope',
      default_requester_email: 'noc@example.com',
      ...iparams
    }
  };
}

// A ticket as returned by /api/platform/v2/service/ticketing/tickets. `status` may be given as a name.
const ticket = (id, extra = {}) => {
  const t = {
    id: String(id),
    number: String(5000 + id),
    summary: `Alert ${id}`,
    description: 'Something broke',
    priority: { id: 'p-high', name: 'High' },
    status: statusRef('Open'),
    company: { id: 'c-1' },
    site: { id: 'site-1' },
    updatedAt: `2026-10-16T10:00:${String(id % 60).padStart(2, '0')}Z`,
    ...extra
  };
  if (typeof t.status === 'string') t.status = statusRef(t.status);
  return t;
};

module.exports = { fakeDb, fakeBackends, makeEnv, ticket, httpError, STATUSES };
