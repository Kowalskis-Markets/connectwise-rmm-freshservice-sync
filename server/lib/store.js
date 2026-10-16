'use strict';

// Key/value persistence on top of $db.
//   cw:<ticketId>       -> { fsId, number, status: 'open'|'resolved', closedBySync, importedAt, resolvedAt }
//   cw_cursor:<name>    -> { updatedSince }  scan position for the 'import' and 'resolve' passes
//   cw_token            -> { token, expiresAt }
//   cw_statuses         -> { closedIds, closeTo: { id, name }, fetchedAt }
//   cw_company:<id>     -> { name }
//   cw_schedule         -> { frequency }     poll interval the schedule was last set to

async function get(env, key) {
  try {
    return await env.db.get(key);
  } catch (err) {
    if (err && err.status === 404) return null;
    throw err;
  }
}

function set(env, key, value) {
  return env.db.set(key, value);
}

const mappingKey = (cwId) => `cw:${cwId}`;
const getMapping = (env, cwId) => get(env, mappingKey(cwId));
const setMapping = (env, cwId, mapping) => set(env, mappingKey(cwId), mapping);

async function getCursor(env, name) {
  const v = await get(env, `cw_cursor:${name}`);
  return (v && v.updatedSince) || null;
}

const setCursor = (env, name, updatedSince) => set(env, `cw_cursor:${name}`, { updatedSince });

Object.assign(exports, { get, set, getMapping, setMapping, getCursor, setCursor });
