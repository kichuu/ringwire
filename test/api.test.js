'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createServer, serve, reply } = require('..');

describe('serve({ fetch })', () => {
  for (const backend of ['io_uring', 'node']) {
    it(`runs a Fetch API handler (${backend})`, async () => {
      const server = serve({
        port: 0,
        host: '127.0.0.1',
        backend,
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === 'POST') {
            return Response.json({ got: await request.json(), path: url.pathname, ua: request.headers.get('user-agent') });
          }
          const res = new Response('hi', { status: 202, headers: { 'x-from': 'fetch' } });
          res.headers.append('set-cookie', 'a=1');
          res.headers.append('set-cookie', 'b=2');
          return res;
        },
      });
      await server.ready;
      try {
        const base = `http://127.0.0.1:${server.port}`;
        let r = await fetch(`${base}/x`);
        assert.strictEqual(r.status, 202);
        assert.strictEqual(r.headers.get('x-from'), 'fetch');
        assert.strictEqual(await r.text(), 'hi');
        if (typeof r.headers.getSetCookie === 'function') assert.deepStrictEqual(r.headers.getSetCookie(), ['a=1', 'b=2']);

        r = await fetch(`${base}/api`, {
          method: 'POST',
          body: JSON.stringify({ n: 1 }),
          headers: { 'content-type': 'application/json', 'user-agent': 'test-agent' },
        });
        assert.deepStrictEqual(await r.json(), { got: { n: 1 }, path: '/api', ua: 'test-agent' });
      } finally {
        await server.close();
      }
    });
  }
});

describe('API validation', () => {
  it('rejects bad arguments early', () => {
    assert.throws(() => createServer('nope'), TypeError);
    assert.throws(() => createServer(() => '', { backend: 'epoll' }), /unknown backend/);
    assert.throws(() => reply(42), /invalid status/);
    assert.throws(() => serve({}), TypeError);
  });

  it('reports the address-in-use error from the io_uring backend', async () => {
    const a = createServer(() => 'a', { port: 0, host: '127.0.0.1', backend: 'node' });
    await a.ready;
    try {
      assert.throws(() => createServer(() => 'b', { port: a.port, host: '127.0.0.1', backend: 'io_uring' }), /in use/i);
    } finally {
      await a.close();
    }
  });

  it('refuses a second io_uring server on a port already served by io_uring', async () => {
    // Regression: SO_REUSEPORT used to let both bind and silently split traffic.
    const a = createServer(() => 'a', { port: 0, host: '127.0.0.1', backend: 'io_uring', threads: 2 });
    try {
      assert.throws(() => createServer(() => 'b', { port: a.port, host: '127.0.0.1', backend: 'io_uring' }), /in use/i);
      // The first server still owns every connection.
      for (let i = 0; i < 20; i++) {
        assert.strictEqual(await (await fetch(`http://127.0.0.1:${a.port}/`)).text(), 'a');
      }
    } finally {
      await a.close();
    }
  });
});
