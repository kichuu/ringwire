<div align="center">

# ringwire

**An io_uring HTTP server for Node.js.**<br>
Networking in Rust on Linux's io_uring. Your handlers stay plain JavaScript or TypeScript.

[![CI](https://github.com/kichuu/ringwire/actions/workflows/ci.yml/badge.svg)](https://github.com/kichuu/ringwire/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ringwire.svg)](https://www.npmjs.com/package/ringwire)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

```js
const { createServer } = require('ringwire');

createServer((req) => ({ hello: 'world', path: req.url }), { port: 3000 });
```

- **Fast**: on a hello-world benchmark, ~3.6× `node:http` with one I/O thread and ~6× with two; ~2.4× `Bun.serve` ([numbers and caveats](#benchmarks)).
- **Node, not a new runtime**: keep your Node version, your npm packages and your deployment.
- **Runs everywhere**: io_uring on Linux; automatic `node:http` fallback on macOS, Windows and in restricted containers, with the same API.
- **Bring your framework**: `serve({ fetch })` runs any Fetch API app, such as [Hono](https://hono.dev).

> [!WARNING]
> ringwire is **young (0.x)**. The API may change between minor versions. It has timeouts, size limits and
> request-smuggling defenses, but it has not been audited or fuzzed yet. Try it behind a reverse proxy first.

## Install

```sh
npm install ringwire
```

Prebuilt binaries ship for Linux **x64 and arm64**, **glibc (2.17+) and musl** (Alpine). npm picks the
right one automatically. Other platforms install fine and use the `node:http` fallback.

Requires Node.js 18+. The io_uring backend needs Linux 5.19+ (6.1+ recommended).

## Usage

### Handlers

A handler receives a request and returns the response. Whatever you return becomes the body:

| Return value               | Response                                  |
|----------------------------|-------------------------------------------|
| `string`                   | `200`, `text/plain; charset=utf-8`        |
| object / array / number    | `200`, `application/json` (stringified)   |
| `Buffer` / `Uint8Array`    | `200`, `application/octet-stream`         |
| `null` / `undefined`       | `204 No Content`                          |
| `reply(status, body, opts)`| anything else: status, headers, type      |
| a `Promise` of any of these| awaited; pipelined responses stay in order|
| thrown error / rejection   | `500`, error logged                       |

```js
const { createServer, reply } = require('ringwire');

const server = createServer(async (req) => {
  if (req.method === 'POST' && req.url === '/posts') {
    const post = JSON.parse(req.body);              // req.body is a Buffer (or null)
    return reply(201, await db.insert(post));
  }
  if (req.url === '/old') return reply(301, null, { headers: { location: '/new' } });
  if (req.url === '/page') return reply(200, '<h1>hi</h1>', 'html');
  return reply(404, { error: 'not found' });
}, { port: 3000 });

await server.ready;
console.log(`listening on ${server.port} using ${server.backend}`);
```

ES modules and TypeScript work out of the box (`import { createServer } from 'ringwire'`; types included).

### Fetch API apps (Hono and others)

```js
import { Hono } from 'hono';
import { serve } from 'ringwire';

const app = new Hono();
app.get('/', (c) => c.text('Hello from Hono on io_uring!'));

serve({ fetch: app.fetch, port: 3000 });
```

`serve` builds a standard `Request` per call, so it costs more than a plain handler but runs any
framework built on `Request → Response`.

## API

### `createServer(handler, options?) → Server`

| Option           | Default    | Description |
|------------------|-----------:|-------------|
| `port`           | `3000`     | Port to listen on. `0` picks a free port. |
| `host`           | `0.0.0.0`  | Address to bind. |
| `threads`        | `1`        | io_uring worker threads. Each has its own ring and `SO_REUSEPORT` listener. 2 is a good start; past that the single JS thread is usually the limit. |
| `headers`        | `false`    | Pass request headers to handlers as a flat `[name, value, …]` array with lowercased names. Off by default because it costs a little per request. |
| `idleTimeout`    | `5000`     | Close keep-alive connections idle for this many ms. `0` disables. |
| `requestTimeout` | `30000`    | Max ms to receive a full request once it starts; slow clients get `408`. `0` disables. |
| `maxBodySize`    | `8 MiB`    | Larger bodies are rejected with `413`. |
| `maxConnections` | `65536`    | Open connections per worker thread. |
| `backend`        | `'auto'`   | `'auto'`: io_uring with fallback. `'io_uring'`: throw if unavailable. `'node'`: always `node:http`. |

**`Request`**: `{ id, method, url, headers, body }`. `url` is the raw path plus query; `body` is a `Buffer` or `null`.

**`Server`**: `{ backend, port, ready, close() }`. `ready` resolves once the server accepts connections;
`close()` stops it and closes all connections.

### `reply(status, body?, options?)`

`options` is a content type (`'json' | 'text' | 'html' | 'binary'`) or `{ type?, headers? }`. Header
values may be arrays (e.g. multiple `set-cookie`). The server manages `content-length`, `date`,
`connection` and `transfer-encoding` itself. A header value containing CR/LF turns the response into a `500`
instead of allowing header injection.

### `serve({ fetch, ...options }) → Server`

Same options as `createServer`, with a Fetch API handler.

## Backends

| Where                                        | Backend      |
|----------------------------------------------|--------------|
| Linux with io_uring                          | `io_uring`   |
| macOS, Windows                               | `node` (fallback) |
| Docker with the default seccomp profile      | `node` (fallback) |
| `kernel.io_uring_disabled=2`, gVisor, some PaaS | `node` (fallback) |

Falling back prints a one-time `RingwireWarning`. To use io_uring inside Docker, run the container with a
seccomp profile that allows `io_uring_setup`, `io_uring_enter` and `io_uring_register` (or
`--security-opt seccomp=unconfined` if you understand the trade-off).

## How it works

```
 worker thread (× threads)                            JS thread
 ┌──────────────────────────────────────┐
 │ io_uring                             │  ONE call per batch
 │  multishot accept → recv → httparse ─┼──────────────────────►  handler(req) × N
 │                                      │                               │
 │  eventfd read wakes the ring ◄───────┼── respond([...]) ◄────────────┘
 │  encode → send (in order per conn)   │      ONE call per batch
 └──────────────────────────────────────┘
```

1. Each worker thread owns an io_uring and a `SO_REUSEPORT` listener, and the kernel spreads connections
   across them. Rings run with `SINGLE_ISSUER | DEFER_TASKRUN | COOP_TASKRUN` where available.
2. Every request parsed in one loop iteration crosses into JS in **one** call, so the JS↔native cost
   is paid per batch, not per request.
3. Sync responses go back in one call too. The worker serializes them (status line, headers, `Date`)
   off the JS thread, and per-connection sequence numbers keep pipelined responses in order even when
   async handlers finish out of order.

Contributors: [`docs/architecture.md`](docs/architecture.md) walks through the event loop and buffer lifetimes.

## Benchmarks

`bench/run.sh` reproduces these. `oha -z 8s -c 256`, keep-alive, 12-core x86-64, Linux 7.0, Node 18.20,
load generator on the same machine:

| Server                | `/plaintext` req/s | `/json` req/s | p99 (plaintext) |
|-----------------------|-------------------:|--------------:|----------------:|
| `node:http`           | 32,874             | 32,458        | 12.9 ms         |
| `Bun.serve` 1.3.5     | 86,179             | 86,064        | 5.3 ms          |
| ringwire, 1 thread    | 119,390            | 121,038       | 2.9 ms          |
| ringwire, 2 threads   | **209,804**        | **203,204**   | **1.9 ms**      |

**Read these honestly:**
- This is hello-world. Real apps spend their time in your code and your database, so expect a smaller
  (but real) gain.
- The load generator shares the CPU with the server; compare rows, not absolute numbers.
- [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) has not been compared yet (help wanted).

## Limitations

- HTTP/1.1 only: no HTTP/2, no TLS (terminate TLS at a proxy such as nginx, Caddy or a load balancer).
- Chunked *request* bodies are rejected with `411`. Responses are always sent with `content-length`
  (no streaming yet).
- No WebSockets yet.
- The fallback backend is plain `node:http` and runs at `node:http` speed.

## Roadmap

- [ ] Streaming request and response bodies
- [ ] Chunked request bodies
- [ ] Provided buffer rings and multishot recv, registered files, zero-copy send
- [ ] Fuzzing the parser and connection state machine
- [ ] Benchmark against uWebSockets.js, plus a realistic DB-backed benchmark
- [ ] WebSockets

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
