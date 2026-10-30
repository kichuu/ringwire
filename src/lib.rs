mod http;
mod worker;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction};
use napi::{JsFunction, JsUnknown};
use napi_derive::napi;
use socket2::{Domain, Socket, Type};
use std::net::{SocketAddr, ToSocketAddrs};
use std::os::fd::IntoRawFd;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// A parsed request on its way to JS.
pub struct Request {
    pub id: f64,
    pub method: String,
    pub url: String,
    pub headers: Option<Vec<String>>,
    pub body: Option<Vec<u8>>,
}

/// Every request one worker parsed during one event-loop iteration.
pub struct Batch {
    pub worker: u32,
    pub reqs: Vec<Request>,
}

#[napi(object)]
pub struct ServerOptions {
    pub port: u32,
    pub host: Option<String>,
    /// Number of io_uring worker threads (default 1).
    pub threads: Option<u32>,
    /// Pass request headers to JS as a flat [name, value, ...] array (default false).
    pub headers: Option<bool>,
    /// Close keep-alive connections idle for this many ms (default 5000, 0 = never).
    pub idle_timeout: Option<u32>,
    /// Max ms to receive a complete request once it starts (default 30000, 0 = never).
    pub request_timeout: Option<u32>,
    /// Largest accepted request body in bytes (default 8 MiB).
    pub max_body_size: Option<u32>,
    /// Max open connections per worker thread (default 65536).
    pub max_connections: Option<u32>,
}

/// Error message prefix JS uses to detect that io_uring is unavailable.
const UNAVAILABLE: &str = "ERR_IO_URING_UNAVAILABLE";

#[napi]
pub struct NativeServer {
    workers: Vec<Arc<worker::Shared>>,
    threads: Vec<JoinHandle<()>>,
    port: u32,
}

/// Fail with EADDRINUSE if anything is already listening on `addr`.
///
/// Our listeners use SO_REUSEPORT so the workers can share a port, but that
/// also lets a second ringwire process on the same port bind successfully and
/// silently split the traffic. A probe socket without SO_REUSEPORT conflicts
/// with any existing listener, so binding it first restores the usual error.
fn ensure_port_free(addr: SocketAddr) -> std::io::Result<()> {
    let probe = Socket::new(Domain::for_address(addr), Type::STREAM, None)?;
    probe.set_reuse_address(true)?; // ignore TIME_WAIT leftovers, like a normal listener
    probe.bind(&addr.into())
}

fn bind(addr: SocketAddr) -> std::io::Result<Socket> {
    let s = Socket::new(Domain::for_address(addr), Type::STREAM, None)?;
    s.set_reuse_address(true)?;
    s.set_reuse_port(true)?;
    s.bind(&addr.into())?;
    s.listen(4096)?;
    Ok(s)
}

fn batch_to_js(ctx: ThreadSafeCallContext<Batch>) -> Result<Vec<JsUnknown>> {
    let env = ctx.env;
    let Batch { worker, reqs } = ctx.value;
    let mut arr = env.create_array_with_length(reqs.len())?;
    for (i, r) in reqs.into_iter().enumerate() {
        let mut o = env.create_object()?;
        o.set_named_property("id", env.create_double(r.id)?)?;
        o.set_named_property("method", env.create_string(&r.method)?)?;
        o.set_named_property("url", env.create_string(&r.url)?)?;
        match r.headers {
            Some(h) => {
                let mut ha = env.create_array_with_length(h.len())?;
                for (j, s) in h.iter().enumerate() {
                    ha.set_element(j as u32, env.create_string(s)?)?;
                }
                o.set_named_property("headers", ha)?;
            }
            None => o.set_named_property("headers", env.get_null()?)?,
        }
        match r.body {
            Some(b) => o.set_named_property("body", env.create_buffer_with_data(b)?.into_raw())?,
            None => o.set_named_property("body", env.get_null()?)?,
        }
        arr.set_element(i as u32, o)?;
    }
    Ok(vec![
        env.create_uint32(worker)?.into_unknown(),
        arr.into_unknown(),
    ])
}

fn ms(v: Option<u32>, default: u32) -> Duration {
    Duration::from_millis(v.unwrap_or(default) as u64)
}

#[napi]
impl NativeServer {
    /// `handler(worker: number, requests: Request[])` is called once per batch.
    #[napi(constructor)]
    pub fn new(opts: ServerOptions, handler: JsFunction) -> Result<Self> {
        // Probe first: io_uring may be compiled out, disabled by sysctl, or
        // blocked by seccomp (Docker's default profile). JS falls back on this.
        if let Err(e) = io_uring::IoUring::new(2) {
            return Err(Error::from_reason(format!("{UNAVAILABLE}: {e}")));
        }

        let host = opts.host.unwrap_or_else(|| "0.0.0.0".to_owned());
        let n = opts.threads.unwrap_or(1).max(1);
        let cfg = worker::Config {
            want_headers: opts.headers.unwrap_or(false),
            idle_timeout: ms(opts.idle_timeout, 5_000),
            request_timeout: ms(opts.request_timeout, 30_000),
            max_body: opts.max_body_size.unwrap_or(8 * 1024 * 1024) as usize,
            max_conns: (opts.max_connections.unwrap_or(65_536) as usize).min(1 << 20),
        };

        let mut addr = (host.as_str(), opts.port as u16)
            .to_socket_addrs()
            .map_err(|e| Error::from_reason(format!("bad address {host}: {e}")))?
            .next()
            .ok_or_else(|| Error::from_reason(format!("cannot resolve {host}")))?;

        // Bind every listener up front so errors (EADDRINUSE...) throw in JS.
        if addr.port() != 0 {
            ensure_port_free(addr)
                .map_err(|e| Error::from_reason(format!("listen {addr}: {e}")))?;
        }
        let mut listeners = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let l = bind(addr).map_err(|e| Error::from_reason(format!("listen {addr}: {e}")))?;
            if addr.port() == 0 {
                // Port 0: all workers share whatever port the kernel picked first.
                addr = l.local_addr()?.as_socket().unwrap();
            }
            listeners.push(l);
        }

        let tsfn: ThreadsafeFunction<Batch, ErrorStrategy::Fatal> =
            handler.create_threadsafe_function(0, batch_to_js)?;

        let mut workers = Vec::with_capacity(n as usize);
        let mut threads = Vec::with_capacity(n as usize);
        for (id, l) in listeners.into_iter().enumerate() {
            let shared = Arc::new(worker::Shared::new()?);
            let (lfd, sh, f) = (l.into_raw_fd(), shared.clone(), tsfn.clone());
            // The ring must be created on the thread that uses it (IORING_SETUP_SINGLE_ISSUER).
            let t = std::thread::Builder::new()
                .name(format!("ringwire-{id}"))
                .spawn(
                    move || match worker::Worker::new(id as u32, lfd, sh, f, cfg) {
                        Ok(w) => w.run(),
                        Err(e) => eprintln!("ringwire: worker {id} failed to create io_uring: {e}"),
                    },
                )?;
            workers.push(shared);
            threads.push(t);
        }

        Ok(Self {
            workers,
            threads,
            port: addr.port() as u32,
        })
    }

    #[napi(getter)]
    pub fn port(&self) -> u32 {
        self.port
    }

    /// Send responses for a batch. All arrays are parallel; `types` indexes the
    /// content-type table in http.rs (0 json, 1 text, 2 html, 3 binary) and
    /// `headers` holds an optional flat [name, value, ...] list per response.
    #[napi]
    pub fn respond(
        &self,
        worker: u32,
        ids: Vec<f64>,
        statuses: Vec<u32>,
        types: Vec<u32>,
        bodies: Vec<Either<String, Buffer>>,
        headers: Vec<Option<Vec<String>>>,
    ) -> Result<()> {
        let shared = self
            .workers
            .get(worker as usize)
            .ok_or_else(|| Error::from_reason("unknown worker"))?;
        let n = ids.len();
        if statuses.len() != n || types.len() != n || bodies.len() != n || headers.len() != n {
            return Err(Error::from_reason("respond(): array lengths differ"));
        }
        let resps = bodies
            .into_iter()
            .zip(headers)
            .enumerate()
            .map(|(i, (body, headers))| worker::Resp {
                id: ids[i] as u64,
                status: statuses[i] as u16,
                ctype: types[i],
                headers,
                body: match body {
                    Either::A(s) => s.into_bytes(),
                    Either::B(b) => b.to_vec(),
                },
            })
            .collect();
        shared.push(resps);
        Ok(())
    }

    /// Stop all workers, close every connection and wait for the threads to exit.
    #[napi]
    pub fn close(&mut self) {
        for w in &self.workers {
            w.stop();
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}
