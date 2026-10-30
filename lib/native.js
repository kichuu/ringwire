'use strict';

const { normalize, failure } = require('./reply');

/** io_uring backend: requests arrive from Rust in batches, responses go back in batches. */
function createNativeServer(binding, handler, options) {
  let native;

  function respondOne(worker, id, [status, type, body, headers]) {
    native.respond(worker, [id], [status], [type], [body], [headers]);
  }

  function onBatch(worker, reqs) {
    const ids = [];
    const statuses = [];
    const types = [];
    const bodies = [];
    const headers = [];
    for (let i = 0; i < reqs.length; i++) {
      const req = reqs[i];
      let result;
      try {
        const out = handler(req);
        if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
          // Async handlers answer on their own; the native side keeps pipelined order.
          out.then(
            (v) => {
              let r;
              try {
                r = normalize(v);
              } catch (e) {
                r = failure(e);
              }
              respondOne(worker, req.id, r);
            },
            (e) => respondOne(worker, req.id, failure(e)),
          );
          continue;
        }
        result = normalize(out);
      } catch (e) {
        result = failure(e);
      }
      ids.push(req.id);
      statuses.push(result[0]);
      types.push(result[1]);
      bodies.push(result[2]);
      headers.push(result[3]);
    }
    // One native call for every synchronous response in the batch.
    if (ids.length) native.respond(worker, ids, statuses, types, bodies, headers);
  }

  native = new binding.NativeServer(
    {
      port: options.port,
      host: options.host,
      threads: options.threads,
      headers: options.headers,
      idleTimeout: options.idleTimeout,
      requestTimeout: options.requestTimeout,
      maxBodySize: options.maxBodySize,
      maxConnections: options.maxConnections,
    },
    onBatch,
  );

  return {
    backend: 'io_uring',
    get port() {
      return native.port;
    },
    ready: Promise.resolve(),
    close() {
      native.close();
      return Promise.resolve();
    },
  };
}

module.exports = { createNativeServer };
