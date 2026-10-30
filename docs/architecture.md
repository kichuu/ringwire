# Architecture

This is a guide for contributors. Read it next to `src/worker.rs`.

## Layers

| File              | Thread  | Job |
|-------------------|---------|-----|
| `src/worker.rs`   | worker  | io_uring event loop: accept, recv, parse, timeouts, send |
| `src/http.rs`     | worker  | Response serialization and header validation |
| `src/lib.rs`      | JS      | napi bindings: `NativeServer`, `respond()`, `close()` |
| `lib/native.js`   | JS      | Calls handlers for each batch, collects responses |
| `lib/fallback.js` | JS      | The same contract on `node:http` |
| `lib/index.js`    | JS      | Backend selection, `serve()` Fetch adapter |

## The worker loop

Each worker owns one ring, one listening socket (`SO_REUSEPORT`) and a slab of connections.

```
loop {
    submit_and_wait(1)                 // one syscall: submit SQEs + wait
    for each completion:
        ACCEPT  -> new Conn, arm recv  (multishot: one SQE, many accepts)
        RECV    -> parse requests, push to batch, re-arm recv
        SEND    -> continue partial send / start next / close if drained
        WAKE    -> eventfd fired: JS queued responses -> encode, send
        TIMER   -> 1 s tick: refresh Date header, enforce timeouts
    if batch not empty: one threadsafe-function call into JS
}
```

### Identifying a request

JS gets an opaque numeric `id` per request. It packs `[head:1][gen:16][seq:16][conn:20]` into
53 bits so it survives as a JS number:

- `conn`: slab index of the connection.
- `gen`: incremented every time a slab slot is reused. A response for a connection that closed
  (and whose slot was reused) is dropped rather than sent to the wrong client.
- `seq`: per-connection request number. Responses are emitted strictly in `seq` order, which is
  what makes HTTP pipelining correct when async handlers finish out of order (`Conn::deliver`).
- `head`: the request was `HEAD`, so encode headers but no body.

### Buffer lifetimes (the unsafe part)

io_uring reads from and writes into our memory *after* `push()` returns. The invariants:

1. `Conn::rbuf` is only resized in `parse()`, which only runs after a recv completion, so the
   kernel is never writing into it at that point.
2. `Conn::sending` is never touched while `send_inflight` is set. New responses go to `Conn::out`,
   and the two are swapped when a send completes.
3. A connection slot is freed only when neither a recv nor a send is in flight. `close_conn` calls
   `shutdown()` to force pending operations to complete, and frees the slot on the last completion.
4. The ring is the first field of `Worker`, so it is dropped before any buffer it might reference.

Any change that breaks one of these is a use-after-free. Please call it out in your PR.

### Timeouts

A 1-second `IORING_OP_TIMEOUT` tick scans connections:

- **Idle**: no partial request, nothing outstanding, quiet for `idleTimeout` → close.
- **Request**: a partial request has been buffered for `requestTimeout` → `408` and close
  (slowloris protection).
- Connections waiting on the application (`outstanding > 0`) are never timed out; handler latency
  is the app's business.

## Crossing into JS

`ThreadsafeFunction` (napi) queues a call onto the JS event loop. One call carries a whole batch, so
under load each loop iteration amortizes the crossing over many requests. Responses return through
`respond()`, which converts bodies, appends them to a mutex-protected queue, and writes the worker's
eventfd only when the queue was empty, since a pending wake already covers later pushes.
