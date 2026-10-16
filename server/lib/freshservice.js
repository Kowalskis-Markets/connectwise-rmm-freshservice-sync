'use strict';

const { invoke, describeError } = require('./http');

const STATUS_RESOLVED = 4;

async function ping(env) {
  await invoke(env, 'fsListTickets');
}

async function createTicket(env, payload) {
  const body = await invoke(env, 'fsCreateTicket', {}, payload);
  const id = body && body.ticket && body.ticket.id;
  if (!id) throw new Error('Freshservice create ticket response did not include ticket.id');
  return id;
}

async function addNote(env, fsId, html) {
  await invoke(env, 'fsAddNote', { id: fsId }, { body: html, private: true });
}

async function resolveTicket(env, fsId, noteHtml) {
  await invoke(env, 'fsUpdateTicket', { id: fsId }, { status: STATUS_RESOLVED });
  if (!noteHtml) return;
  try {
    await addNote(env, fsId, noteHtml);
  } catch (err) {
    env.log.error(`Resolved Freshservice ticket ${fsId} but could not add note: ${describeError(err)}`);
  }
}

Object.assign(exports, { ping, createTicket, addNote, resolveTicket, STATUS_RESOLVED });
