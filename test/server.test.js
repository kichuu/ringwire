'use strict';

// Behaviour tests run against both backends: everything here must hold
// whether requests are served by io_uring or by the node:http fallback.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer, reply } = require('..');
const { exchange, get, close, bodyOf, headerOf } = require('./helpers');

function app(req) {
  switch (req.url) {
    case '/plaintext':
      return 'Hello, World!';
    case '/json':
      return { message: 'Hello, World!' };
    case '/echo':
      return req.method === 'POST' ? req.body : reply(405, 'POST only');
    case '/slow':
      return new Promise((r) => setTimeout(() => r({ slow: true }), 20));
    case '/throw':
      throw new Error('boom (expected in tests)');
    case '/headers':
      return req.headers;
    case '/custom':
      return reply(201, '<b>made</b>', { type: 'html', headers: { 'x-request-id': 'abc', 'set-cookie': ['a=1', 'b=2'] } });
    case '/redirect':
      return reply(302, null, { headers: { location: '/plaintext' } });
    case '/inject':
      return reply(200, 'x', { headers: { 'x-evil': 'ok\r\nset-cookie: pwned=1' } });
    case '/png':
      return reply(200, Buffer.from([0x89, 0x50]), { headers: { 'content-type': 'image/png' } });
    case '/empty':
      return undefined;
    default:
      return reply(404, 'Not Found');
  }
}

for (const backend of ['io_uring', 'node']) {
  describe(`${backend} backend`, () => {
    let server;
    let port;

    before(async () => {
      server = createServer(app, { port: 0, host: '127.0.0.1', headers: true, backend });
      await server.ready;
      port = server.port;
      assert.strictEqual(server.backend, backend);
    });

    after(() => server.close());

    it('serves text and JSON with a Date header', async () => {
      let r = await exchange(port, get('/plaintext', close));
      assert.match(r.data, /^HTTP\/1.1 200 OK\r\n/);
      assert.strictEqual(headerOf(r.data, 'content-type'), 'text/plain; charset=utf-8');
      assert.ok(!Number.isNaN(Date.parse(headerOf(r.data, 'date'))), 'Date header must be an HTTP date');
      assert.strictEqual(bodyOf(r.data), 'Hello, World!');

      r = await exchange(port, get('/json', close));
      assert.strictEqual(headerOf(r.data, 'content-type'), 'application/json');
      assert.deepStrictEqual(JSON.parse(bodyOf(r.data)), { message: 'Hello, World!' });
    });

    it('maps reply() statuses, thrown errors and empty results', async () => {
      assert.match((await exchange(port, get('/missing', close))).data, /^HTTP\/1.1 404/);
      assert.match((await exchange(port, get('/echo', close))).data, /^HTTP\/1.1 405/);
      assert.match((await exchange(port, get('/throw', close))).data, /^HTTP\/1.1 500/);
      const r = await exchange(port, get('/empty', close));
      assert.match(r.data, /^HTTP\/1.1 204/);
      assert.strictEqual(headerOf(r.data, 'content-length'), undefined);
    });

    it('sends custom response headers, including repeated ones', async () => {
      const r = await exchange(port, get('/custom', close));
      assert.match(r.data, /^HTTP\/1.1 201/);
      assert.strictEqual(headerOf(r.data, 'x-request-id'), 'abc');
      assert.strictEqual(headerOf(r.data, 'content-type'), 'text/html; charset=utf-8');
      assert.deepStrictEqual(r.data.match(/^set-cookie: .*$/gim).map((l) => l.trim().slice(12)), ['a=1', 'b=2']);
      assert.strictEqual(bodyOf(r.data), '<b>made</b>');

      const png = await exchange(port, get('/png', close));
      assert.strictEqual(headerOf(png.data, 'content-type'), 'image/png');

      const red = await exchange(port, get('/redirect', close));
      assert.match(red.data, /^HTTP\/1.1 302/);
      assert.strictEqual(headerOf(red.data, 'location'), '/plaintext');
    });

    it('refuses header injection (CR/LF in a value) with a 500', async () => {
      const r = await exchange(port, get('/inject', close));
      assert.match(r.data, /^HTTP\/1.1 500/);
      assert.doesNotMatch(r.data, /pwned/);
    });

    it('answers HEAD with headers only', async () => {
      const r = await exchange(port, `HEAD /plaintext HTTP/1.1\r\nHost: x\r\n${close}\r\n`);
      assert.match(r.data, /^HTTP\/1.1 200/);
      assert.strictEqual(headerOf(r.data, 'content-length'), '13');
      assert.strictEqual(bodyOf(r.data), '');
    });

    it('passes request headers when enabled', async () => {
      const r = await exchange(port, get('/headers', `X-Test: Yes\r\n${close}`));
      const h = JSON.parse(bodyOf(r.data));
      assert.strictEqual(h[h.indexOf('x-test') + 1], 'Yes');
    });

    it('echoes a 1 MB POST body byte-for-byte', async () => {
      const body = Buffer.alloc(1_000_000, 'abcdefghij');
      const r = await exchange(
        port,
        Buffer.concat([Buffer.from(`POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n${close}\r\n`), body]),
        5000,
      );
      assert.ok(r.raw.subarray(r.raw.indexOf('\r\n\r\n') + 4).equals(body));
    });

    it('serves many keep-alive requests on one connection', async () => {
      const reqs = Array.from({ length: 50 }, () => get('/plaintext')).join('') + get('/plaintext', close);
      const r = await exchange(port, reqs);
      assert.strictEqual(r.data.match(/Hello, World!/g).length, 51);
      assert.ok(r.closed);
    });

    it('keeps pipelined responses in request order when an async handler finishes last', async () => {
      const r = await exchange(port, get('/slow') + get('/plaintext') + get('/json', close));
      const order = [...r.data.matchAll(/\r\n\r\n(\{"slow":true\}|Hello, World!|\{"message":"Hello, World!"\})/g)].map(
        (m) => m[1],
      );
      assert.deepStrictEqual(order, ['{"slow":true}', 'Hello, World!', '{"message":"Hello, World!"}']);
      assert.ok(r.closed, 'server should close after Connection: close');
    });

    it('parses a request trickled in byte by byte', async () => {
      const msg = 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello';
      const r = await exchange(port, [...msg]);
      assert.strictEqual(bodyOf(r.data), 'hello');
    });

    it('closes HTTP/1.0 connections after the response', async () => {
      const r = await exchange(port, 'GET /plaintext HTTP/1.0\r\n\r\n');
      assert.match(r.data, /Hello, World!$/);
      assert.ok(r.closed);
    });

    it('rejects malformed requests and closes the connection', async () => {
      let r = await exchange(port, 'GARBAGE\x01\r\n\r\n');
      assert.match(r.data, /^HTTP\/1.1 400/);
      assert.ok(r.closed);

      r = await exchange(port, 'GET /plaintext HTTP/1.1\r\n\r\n');
      assert.match(r.data, /^HTTP\/1.1 400/, 'HTTP/1.1 without Host must be rejected');

      r = await exchange(port, 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: nope\r\n\r\n');
      assert.match(r.data, /^HTTP\/1.1 400/);

      r = await exchange(port, 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab');
      assert.match(r.data, /^HTTP\/1.1 400/, 'conflicting Content-Length (request smuggling) must be rejected');

      r = await exchange(port, `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(70 * 1024)}\r\n\r\n`);
      assert.match(r.data, /^HTTP\/1.1 431/);
    });
  });
}

describe('limits and timeouts (io_uring)', () => {
  let server;
  let port;

  before(() => {
    server = createServer(app, {
      port: 0,
      host: '127.0.0.1',
      backend: 'io_uring',
      idleTimeout: 1000,
      requestTimeout: 1000,
      maxBodySize: 1024,
    });
    port = server.port;
  });

  after(() => server.close());

  it('rejects bodies over maxBodySize with 413', async () => {
    const r = await exchange(port, `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 2048\r\n\r\n`);
    assert.match(r.data, /^HTTP\/1.1 413/);
  });

  it('rejects chunked request bodies with 411', async () => {
    const r = await exchange(port, 'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n');
    assert.match(r.data, /^HTTP\/1.1 411/);
  });

  it('closes idle keep-alive connections', async () => {
    const start = Date.now();
    const r = await exchange(port, get('/plaintext'), 5000);
    assert.match(r.data, /Hello, World!/);
    assert.ok(r.closed, 'idle connection should be closed by the server');
    assert.ok(Date.now() - start >= 900, 'not before idleTimeout');
  });

  it('answers a stalled request (slowloris) with 408 and closes', async () => {
    const r = await exchange(port, 'GET /plaintext HTTP/1.1\r\nHost: x\r\nX-Slow: ', 5000);
    assert.match(r.data, /^HTTP\/1.1 408/);
    assert.ok(r.closed);
  });
});
