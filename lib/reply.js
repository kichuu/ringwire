'use strict';

// Must match CONTENT_TYPES in src/http.rs.
const TYPE = { json: 0, text: 1, html: 2, binary: 3 };
const MIME = [
  'application/json',
  'text/plain; charset=utf-8',
  'text/html; charset=utf-8',
  'application/octet-stream',
];

/** Explicit response created by reply(). */
class Reply {
  constructor(status, body, type, headers) {
    this.status = status;
    this.body = body;
    this.type = type;
    this.headers = headers;
  }
}

/**
 * reply(201, { ok: true })
 * reply(200, '<h1>hi</h1>', 'html')
 * reply(302, null, { headers: { location: '/login' } })
 */
function reply(status, body = null, options) {
  if (!Number.isInteger(status) || status < 100 || status > 999) {
    throw new TypeError(`reply(): invalid status ${status}`);
  }
  if (typeof options === 'string') return new Reply(status, body, options, null);
  return new Reply(status, body, options && options.type, options && options.headers ? flattenHeaders(options.headers) : null);
}

/** { a: '1', 'set-cookie': ['x', 'y'] } -> ['a', '1', 'set-cookie', 'x', 'set-cookie', 'y'] */
function flattenHeaders(headers) {
  if (Array.isArray(headers)) return headers.map(String);
  const flat = [];
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) flat.push(name, String(v));
    else flat.push(name, String(value));
  }
  return flat;
}

/** Turn whatever a handler returned into [status, typeCode, body, flatHeaders|null]. */
function normalize(out) {
  let status = 200;
  let type;
  let headers = null;
  if (out instanceof Reply) {
    ({ status, type, headers } = out);
    out = out.body;
  }
  const code = type === undefined ? undefined : TYPE[type];
  if (type !== undefined && code === undefined) throw new TypeError(`unknown response type "${type}"`);
  if (out === undefined || out === null) return [status === 200 ? 204 : status, TYPE.text, '', headers];
  if (typeof out === 'string') return [status, code ?? TYPE.text, out, headers];
  if (Buffer.isBuffer(out)) return [status, code ?? TYPE.binary, out, headers];
  if (out instanceof Uint8Array) {
    return [status, code ?? TYPE.binary, Buffer.from(out.buffer, out.byteOffset, out.byteLength), headers];
  }
  return [status, code ?? TYPE.json, JSON.stringify(out), headers];
}

function failure(err) {
  console.error(err);
  return [500, TYPE.text, 'Internal Server Error', null];
}

module.exports = { reply, normalize, failure, flattenHeaders, MIME };
