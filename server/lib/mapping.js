'use strict';

// Freshservice priority: 1 Low, 2 Medium, 3 High, 4 Urgent.
const PRIORITY_BY_NAME = {
  critical: 4,
  urgent: 4,
  emergency: 4,
  high: 3,
  medium: 2,
  normal: 2,
  moderate: 2,
  low: 1,
  info: 1,
  informational: 1
};
// ConnectWise numeric priorities run 1 (highest) to 4 (lowest).
const PRIORITY_BY_NUMBER = { 1: 4, 2: 3, 3: 2, 4: 1 };

const FS_STATUS_OPEN = 2;
const FS_SOURCE_PORTAL = 2;
const TAG = 'connectwise-rmm';

function mapPriority(value) {
  if (value === undefined || value === null || value === '') return 2;
  const n = Number(value);
  if (Number.isInteger(n) && PRIORITY_BY_NUMBER[n]) return PRIORITY_BY_NUMBER[n];
  const key = String(value).toLowerCase().replace(/^p\d\s*-?\s*/, '').trim();
  return PRIORITY_BY_NAME[key] || 2;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDescription(t) {
  const rows = [
    ['ConnectWise ticket', t.number || t.id],
    ['Company', t.company],
    ['Priority', t.priority],
    ['Created', t.createdAt]
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  const table = rows.map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`).join('');
  const body = t.description ? `<p>${escapeHtml(t.description).replace(/\r?\n/g, '<br>')}</p>` : '';
  return `${body}<table>${table}</table>`;
}

function toFreshservice(ticket, iparams) {
  const payload = {
    subject: `[CW ${ticket.number || ticket.id}] ${ticket.subject}`.slice(0, 255),
    description: buildDescription(ticket),
    email: iparams.default_requester_email, // ConnectWise tickets carry no contact email
    priority: mapPriority(ticket.priority),
    status: FS_STATUS_OPEN,
    source: FS_SOURCE_PORTAL,
    tags: [TAG, `cw-${ticket.number || ticket.id}`]
  };
  const groupId = Number(iparams.fs_group_id);
  if (iparams.fs_group_id && Number.isInteger(groupId)) payload.group_id = groupId;
  return payload;
}

Object.assign(exports, { toFreshservice, mapPriority, escapeHtml });
