'use strict';

// Thin wrapper over $request.invokeTemplate. Template context values must be strings.
async function invoke(env, template, context = {}, body) {
  const ctx = {};
  for (const [k, v] of Object.entries(context)) ctx[k] = v === null || v === undefined ? '' : String(v);
  const opts = { context: ctx };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await env.request.invokeTemplate(template, opts);
  return parse(res.response);
}

function parse(text) {
  if (text === null || text === undefined || text === '') return null;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return text; // non-JSON body
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.status) {
    const detail = typeof err.response === 'string' ? err.response.slice(0, 500) : JSON.stringify(err.response || err.message || '');
    return `HTTP ${err.status}: ${detail}`;
  }
  return err.message || String(err);
}

Object.assign(exports, { invoke, parse, describeError });
