'use strict';

const assert = require('node:assert/strict');
const { toFreshservice, mapPriority } = require('../server/lib/mapping');
const { normalize } = require('../server/lib/connectwise');

test('mapPriority handles names, CW numbers, and unknowns', () => {
  assert.equal(mapPriority('Critical'), 4);
  assert.equal(mapPriority('high'), 3);
  assert.equal(mapPriority('P3 - Medium'), 2);
  assert.equal(mapPriority(1), 4);
  assert.equal(mapPriority('4'), 1);
  assert.equal(mapPriority(undefined), 2);
  assert.equal(mapPriority('weird'), 2);
});

test('toFreshservice builds a valid ticket payload from a Platform API ticket', () => {
  const t = normalize({
    id: '0b6f…uuid',
    number: '42',
    summary: 'CPU <high>',
    description: 'line1\nline2',
    priority: { id: 'p1', name: 'Critical' },
    status: { id: 's-open', name: 'Open' },
    company: { id: 'c-1' },
    createdAt: '2026-10-16T10:00:00Z'
  });
  const p = toFreshservice({ ...t, company: 'Acme' }, { default_requester_email: 'noc@example.com', fs_group_id: '17' });
  assert.equal(p.subject, '[CW 42] CPU <high>');
  assert.equal(p.email, 'noc@example.com');
  assert.equal(p.priority, 4);
  assert.equal(p.status, 2);
  assert.equal(p.group_id, 17);
  assert.deepEqual(p.tags, ['connectwise-rmm', 'cw-42']);
  assert.match(p.description, /line1<br>line2/);
  assert.match(p.description, /Acme/);
  assert.doesNotMatch(p.description, /<high>/);
});

test('toFreshservice falls back to the ticket id and skips a bad group id', () => {
  const p = toFreshservice(normalize({ id: 'abc' }), { default_requester_email: 'noc@example.com', fs_group_id: 'x' });
  assert.equal(p.subject, '[CW abc] ConnectWise RMM ticket abc');
  assert.equal(p.group_id, undefined);
});

test('normalize reads the Platform API ticket shape', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize({ summary: 'no id' }), null);
  const t = normalize({
    id: 'u1',
    number: 1001,
    status: { id: 's-closed', name: 'Closed' },
    priority: { name: 'Low' },
    company: { id: 'c-9' },
    site: { id: 'site-2' },
    updatedAt: '2026-10-16T11:00:00Z'
  });
  assert.equal(t.id, 'u1');
  assert.equal(t.number, '1001');
  assert.equal(t.statusId, 's-closed');
  assert.equal(t.status, 'Closed');
  assert.equal(t.priority, 'Low');
  assert.equal(t.companyId, 'c-9');
  assert.equal(t.siteId, 'site-2');
  assert.equal(t.updatedAt, '2026-10-16T11:00:00Z');
});
