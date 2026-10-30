'use strict';

const { binding, error: bindingError } = require('./binding');
const { createNativeServer } = require('./native');
const { createFallbackServer } = require('./fallback');
const { reply } = require('./reply');

const UNAVAILABLE = 'ERR_IO_URING_UNAVAILABLE';
let warned = false;

function warnFallback(reason) {
  if (warned) return;
  warned = true;
  process.emitWarning(`io_uring unavailable (${reason}); using the node:http fallback`, {
    type: 'RingwireWarning',
    code: 'RINGWIRE_FALLBACK',
  });
}

/**
 * Start an HTTP server. `handler(req)` returns a string, Buffer, JSON-able
 * value, reply(...), or a Promise of one of those.
 */
function createServer(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('createServer(handler): handler must be a function');
  const opts = { ...options, port: options.port ?? 3000 };
  const backend = opts.backend ?? 'auto';
  if (!['auto', 'io_uring', 'node'].includes(backend)) {
    throw new TypeError(`unknown backend "${backend}" (expected "auto", "io_uring" or "node")`);
  }

  if (backend === 'node') return createFallbackServer(handler, opts);

  if (!binding) {
    if (backend === 'io_uring') throw bindingError;
    warnFallback(bindingError.message);
    return createFallbackServer(handler, opts);
  }
  try {
    return createNativeServer(binding, handler, opts);
  } catch (e) {
    if (backend === 'auto' && String(e.message).startsWith(UNAVAILABLE)) {
      warnFallback(e.message.slice(UNAVAILABLE.length + 2));
      return createFallbackServer(handler, opts);
    }
    throw e;
  }
}

/**
 * Run a Fetch API handler (Request -> Response), e.g. a Hono app:
 *   serve({ fetch: app.fetch, port: 3000 })
 */
function serve({ fetch, ...options }) {
  if (typeof fetch !== 'function') throw new TypeError('serve({ fetch }): fetch must be a function');
  return createServer(
    async (req) => {
      const headers = new Headers();
      for (let i = 0; i < req.headers.length; i += 2) headers.append(req.headers[i], req.headers[i + 1]);
      const hasBody = req.body !== null && req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`http://${headers.get('host') ?? 'localhost'}${req.url}`, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
      });
      const res = await fetch(request);
      const out = [];
      res.headers.forEach((value, name) => {
        if (name !== 'set-cookie') out.push(name, value);
      });
      // Headers.forEach joins Set-Cookie values with ", ", which breaks cookies.
      if (typeof res.headers.getSetCookie === 'function') {
        for (const c of res.headers.getSetCookie()) out.push('set-cookie', c);
      } else if (res.headers.has('set-cookie')) {
        out.push('set-cookie', res.headers.get('set-cookie'));
      }
      const body = res.body ? Buffer.from(await res.arrayBuffer()) : null;
      return reply(res.status, body, { type: 'binary', headers: out });
    },
    { ...options, headers: true },
  );
}

module.exports = { createServer, serve, reply };
