'use strict';

// Portable backend on node:http, used where io_uring is unavailable (macOS,
// Windows, Docker's default seccomp profile). Same handler contract, slower.
const http = require('node:http');
const { normalize, failure, MIME } = require('./reply');

function createFallbackServer(handler, options) {
  const maxBody = options.maxBodySize ?? 8 * 1024 * 1024;
  let nextId = 0;

  function send(res, [status, type, body, headers]) {
    if (res.writableEnded || res.destroyed) return;
    const out = {};
    if (headers) {
      for (let i = 0; i < headers.length; i += 2) {
        const name = headers[i].toLowerCase();
        if (name === 'content-length' || name === 'transfer-encoding' || name === 'connection' || name === 'date') continue;
        if (out[name] === undefined) out[name] = headers[i + 1];
        else out[name] = [].concat(out[name], headers[i + 1]);
      }
    }
    if (status !== 204 && status !== 304 && status >= 200) {
      if (out['content-type'] === undefined) out['content-type'] = MIME[type];
      out['content-length'] = Buffer.byteLength(body);
    }
    try {
      res.writeHead(status, out);
    } catch (e) {
      // Invalid header name/value (e.g. CR/LF injection): same outcome as the native backend.
      if (!res.headersSent) return send(res, failure(e));
      return res.destroy();
    }
    res.end(status === 204 || status === 304 ? undefined : body);
  }

  function dispatch(req, res, body) {
    let headers = null;
    if (options.headers) {
      headers = [];
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) headers.push(raw[i].toLowerCase(), raw[i + 1]);
    }
    const request = { id: nextId++, method: req.method, url: req.url, headers, body };
    let out;
    try {
      out = handler(request);
    } catch (e) {
      return send(res, failure(e));
    }
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
      out.then(
        (v) => {
          let r;
          try {
            r = normalize(v);
          } catch (e) {
            r = failure(e);
          }
          send(res, r);
        },
        (e) => send(res, failure(e)),
      );
      return;
    }
    let r;
    try {
      r = normalize(out);
    } catch (e) {
      r = failure(e);
    }
    send(res, r);
  }

  const server = http.createServer({ requireHostHeader: true }, (req, res) => {
    // Node 20+ enforces this itself (RFC 9112 §3.2); Node 18 does not.
    if (req.httpVersion === '1.1' && req.headers.host === undefined) {
      res.writeHead(400, { connection: 'close' }).end('Bad Request');
      return req.destroy();
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) {
      res.writeHead(413, { connection: 'close' }).end('Payload Too Large');
      return req.destroy();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) {
        res.writeHead(413, { connection: 'close' }).end('Payload Too Large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => dispatch(req, res, size ? Buffer.concat(chunks) : null));
  });

  const idle = options.idleTimeout ?? 5000;
  const request = options.requestTimeout ?? 30000;
  server.keepAliveTimeout = idle;
  server.requestTimeout = request;
  server.headersTimeout = request;
  if (options.maxConnections) server.maxConnections = options.maxConnections;

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    backend: 'node',
    get port() {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : options.port;
    },
    ready,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}

module.exports = { createFallbackServer };
