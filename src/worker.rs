//! One worker = one thread + one io_uring + one SO_REUSEPORT listener.
//!
//! Event loop per iteration:
//!   1. submit pending SQEs and wait for at least one completion
//!   2. handle every completion (accept / recv / send / wake / timer)
//!   3. hand all requests parsed in this iteration to JS in ONE call
//!
//! Responses come back from the JS thread through `Shared::push`, which
//! queues them and pokes an eventfd that the ring is reading, so the ring
//! wakes up, serializes them and writes them out.

use crate::{http, Batch, Request};
use io_uring::{cqueue, opcode, squeue, types, IoUring};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::collections::BTreeMap;
use std::io;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

const RING_ENTRIES: u32 = 4096;
const INITIAL_RBUF: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 64;
const TICK: Duration = Duration::from_secs(1);

// user_data layout: [op: 8 bits][unused][conn index: 32 bits]
const OP_ACCEPT: u64 = 1;
const OP_RECV: u64 = 2;
const OP_SEND: u64 = 3;
const OP_WAKE: u64 = 4;
const OP_TIMER: u64 = 5;

fn ud(op: u64, idx: usize) -> u64 {
    (op << 56) | idx as u64
}

// Request id handed to JS (must fit in 53 bits to survive as a JS number):
//   [head: 1][gen: 16][seq: 16][conn index: 20]
const IDX_BITS: u64 = 20;
const MAX_CONNS: usize = 1 << IDX_BITS;
const HEAD_BIT: u64 = 1 << 52;

fn make_id(idx: usize, gen: u16, seq: u16, head: bool) -> u64 {
    let id = ((gen as u64) << 36) | ((seq as u64) << IDX_BITS) | idx as u64;
    if head {
        id | HEAD_BIT
    } else {
        id
    }
}

fn split_id(id: u64) -> (usize, u16, u16, bool) {
    (
        (id & (MAX_CONNS as u64 - 1)) as usize,
        ((id >> 36) & 0xFFFF) as u16,
        ((id >> IDX_BITS) & 0xFFFF) as u16,
        id & HEAD_BIT != 0,
    )
}

fn http_date() -> String {
    httpdate::fmt_http_date(SystemTime::now())
}

#[derive(Clone, Copy)]
pub struct Config {
    pub want_headers: bool,
    /// Close keep-alive connections idle this long (zero disables).
    pub idle_timeout: Duration,
    /// Max time to receive a full request once it has started (zero disables).
    pub request_timeout: Duration,
    pub max_body: usize,
    pub max_conns: usize,
}

/// A response from JS, serialized on the worker thread.
pub struct Resp {
    pub id: u64,
    pub status: u16,
    pub ctype: u32,
    pub headers: Option<Vec<String>>,
    pub body: Vec<u8>,
}

/// State shared between the JS thread and one worker.
pub struct Shared {
    queue: Mutex<Vec<Resp>>,
    efd: RawFd,
    stop: AtomicBool,
}

impl Shared {
    pub fn new() -> io::Result<Self> {
        let efd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
        if efd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            queue: Mutex::new(Vec::new()),
            efd,
            stop: AtomicBool::new(false),
        })
    }

    pub fn push(&self, mut resps: Vec<Resp>) {
        let was_empty = {
            let mut q = self.queue.lock().unwrap();
            let was_empty = q.is_empty();
            q.append(&mut resps);
            was_empty
        };
        // A non-empty queue means a wake-up is already pending.
        if was_empty {
            self.wake();
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.wake();
    }

    fn wake(&self) {
        let one: u64 = 1;
        unsafe { libc::write(self.efd, &one as *const u64 as *const libc::c_void, 8) };
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        unsafe { libc::close(self.efd) };
    }
}

struct Conn {
    fd: RawFd,
    gen: u16,
    /// Receive buffer; `filled` bytes at the front are unparsed input.
    rbuf: Vec<u8>,
    filled: usize,
    recv_inflight: bool,
    /// Bytes currently owned by an in-flight send. Never touched while
    /// `send_inflight` is set, because the kernel is reading from it.
    sending: Vec<u8>,
    sent: usize,
    send_inflight: bool,
    /// Responses ready to go out after the current send finishes.
    out: Vec<u8>,
    next_req_seq: u16,
    next_send_seq: u16,
    /// Out-of-order responses waiting for earlier ones (pipelining + async handlers).
    pending: BTreeMap<u16, Vec<u8>>,
    /// Client asked for `Connection: close` (or spoke HTTP/1.0): close once drained.
    close_after_drain: bool,
    closing: bool,
    last_active: Instant,
    /// When the first byte of a still-incomplete request arrived.
    partial_since: Option<Instant>,
}

impl Conn {
    fn new(fd: RawFd, gen: u16, now: Instant) -> Self {
        Self {
            fd,
            gen,
            rbuf: vec![0; INITIAL_RBUF],
            filled: 0,
            recv_inflight: false,
            sending: Vec::new(),
            sent: 0,
            send_inflight: false,
            out: Vec::new(),
            next_req_seq: 0,
            next_send_seq: 0,
            pending: BTreeMap::new(),
            close_after_drain: false,
            closing: false,
            last_active: now,
            partial_since: None,
        }
    }

    /// Queue a response for sequence `seq`, keeping pipelined responses in order.
    fn deliver(&mut self, seq: u16, bytes: Vec<u8>) {
        // Ignore ids that are not outstanding (duplicate or stale respond()).
        if seq.wrapping_sub(self.next_send_seq) >= self.outstanding() {
            return;
        }
        if seq != self.next_send_seq {
            self.pending.insert(seq, bytes);
            return;
        }
        if self.out.is_empty() {
            self.out = bytes;
        } else {
            self.out.extend_from_slice(&bytes);
        }
        self.next_send_seq = self.next_send_seq.wrapping_add(1);
        while let Some(b) = self.pending.remove(&self.next_send_seq) {
            self.out.extend_from_slice(&b);
            self.next_send_seq = self.next_send_seq.wrapping_add(1);
        }
    }

    /// Requests handed out that have not been answered (in order) yet.
    fn outstanding(&self) -> u16 {
        self.next_req_seq.wrapping_sub(self.next_send_seq)
    }

    fn drained(&self) -> bool {
        self.outstanding() == 0 && self.out.is_empty() && !self.send_inflight
    }
}

pub struct Worker {
    // Declared first so the ring is torn down before the buffers it may reference.
    ring: IoUring,
    id: u32,
    lfd: RawFd,
    shared: Arc<Shared>,
    tsfn: ThreadsafeFunction<Batch, ErrorStrategy::Fatal>,
    cfg: Config,
    conns: Vec<Option<Conn>>,
    gens: Vec<u16>,
    free: Vec<usize>,
    active: usize,
    batch: Vec<Request>,
    wake_buf: Box<[u8; 8]>,
    tick: Box<types::Timespec>,
    now: Instant,
    date: String,
}

fn build_ring() -> io::Result<IoUring> {
    // SINGLE_ISSUER + DEFER_TASKRUN (Linux 6.1+) let the kernel batch completion
    // work until we call io_uring_enter, which suits this loop. Fall back if unsupported.
    IoUring::builder()
        .setup_single_issuer()
        .setup_defer_taskrun()
        .setup_coop_taskrun()
        .build(RING_ENTRIES)
        .or_else(|_| IoUring::builder().build(RING_ENTRIES))
}

/// Push an SQE, flushing the submission queue to the kernel if it is full.
fn push(ring: &mut IoUring, entry: &squeue::Entry) {
    // SAFETY: every buffer referenced by an SQE is owned by a `Conn` (or the
    // worker) that is not freed or moved until its completion has been seen.
    unsafe {
        while ring.submission().push(entry).is_err() {
            ring.submit().expect("io_uring submit failed");
        }
    }
}

impl Worker {
    /// Must be called on the thread that will run the loop (IORING_SETUP_SINGLE_ISSUER).
    pub fn new(
        id: u32,
        lfd: RawFd,
        shared: Arc<Shared>,
        tsfn: ThreadsafeFunction<Batch, ErrorStrategy::Fatal>,
        cfg: Config,
    ) -> io::Result<Self> {
        Ok(Self {
            ring: build_ring()?,
            id,
            lfd,
            shared,
            tsfn,
            cfg,
            conns: Vec::new(),
            gens: Vec::new(),
            free: Vec::new(),
            active: 0,
            batch: Vec::new(),
            wake_buf: Box::new([0; 8]),
            tick: Box::new(types::Timespec::new().sec(TICK.as_secs())),
            now: Instant::now(),
            date: http_date(),
        })
    }

    pub fn run(mut self) {
        self.arm_accept();
        self.arm_wake();
        self.arm_timer();
        let mut cqes: Vec<(u64, i32, u32)> = Vec::with_capacity(RING_ENTRIES as usize);
        loop {
            if let Err(e) = self.ring.submit_and_wait(1) {
                if e.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                eprintln!("ringwire: worker {} io_uring_enter failed: {e}", self.id);
                break;
            }
            self.now = Instant::now();
            cqes.clear();
            cqes.extend(
                self.ring
                    .completion()
                    .map(|c| (c.user_data(), c.result(), c.flags())),
            );
            for &(data, res, flags) in &cqes {
                let idx = (data & 0xFFFF_FFFF) as usize;
                match data >> 56 {
                    OP_ACCEPT => {
                        if res >= 0 {
                            self.on_accept(res);
                        }
                        if !cqueue::more(flags) && !self.stopping() {
                            self.arm_accept();
                        }
                    }
                    OP_RECV => self.on_recv(idx, res),
                    OP_SEND => self.on_send(idx, res),
                    OP_WAKE => {
                        self.on_wake();
                        if !self.stopping() {
                            self.arm_wake();
                        }
                    }
                    OP_TIMER => {
                        self.on_tick();
                        if !self.stopping() {
                            self.arm_timer();
                        }
                    }
                    _ => {}
                }
            }
            if !self.batch.is_empty() {
                let reqs = std::mem::take(&mut self.batch);
                self.tsfn.call(
                    Batch {
                        worker: self.id,
                        reqs,
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
            if self.stopping() {
                break;
            }
        }
        self.shutdown();
    }

    fn stopping(&self) -> bool {
        self.shared.stop.load(Ordering::Acquire)
    }

    fn arm_accept(&mut self) {
        let e = opcode::AcceptMulti::new(types::Fd(self.lfd))
            .build()
            .user_data(ud(OP_ACCEPT, 0));
        push(&mut self.ring, &e);
    }

    fn arm_wake(&mut self) {
        let e = opcode::Read::new(types::Fd(self.shared.efd), self.wake_buf.as_mut_ptr(), 8)
            .build()
            .user_data(ud(OP_WAKE, 0));
        push(&mut self.ring, &e);
    }

    fn arm_timer(&mut self) {
        let e = opcode::Timeout::new(&*self.tick)
            .build()
            .user_data(ud(OP_TIMER, 0));
        push(&mut self.ring, &e);
    }

    fn arm_recv(&mut self, idx: usize) {
        let c = self.conns[idx].as_mut().unwrap();
        let free = &mut c.rbuf[c.filled..];
        let e = opcode::Recv::new(types::Fd(c.fd), free.as_mut_ptr(), free.len() as u32)
            .build()
            .user_data(ud(OP_RECV, idx));
        c.recv_inflight = true;
        push(&mut self.ring, &e);
    }

    fn on_accept(&mut self, fd: RawFd) {
        if self.active >= self.cfg.max_conns {
            unsafe { libc::close(fd) };
            return;
        }
        let idx = match self.free.pop() {
            Some(i) => i,
            None => {
                self.conns.push(None);
                self.gens.push(0);
                self.conns.len() - 1
            }
        };
        let one: libc::c_int = 1;
        unsafe {
            libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_NODELAY,
                &one as *const _ as *const libc::c_void,
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
        self.gens[idx] = self.gens[idx].wrapping_add(1);
        self.conns[idx] = Some(Conn::new(fd, self.gens[idx], self.now));
        self.active += 1;
        self.arm_recv(idx);
    }

    fn on_recv(&mut self, idx: usize, res: i32) {
        let now = self.now;
        let Some(c) = self.conns[idx].as_mut() else {
            return;
        };
        c.recv_inflight = false;
        if res <= 0 || c.closing {
            self.close_conn(idx);
            return;
        }
        c.filled += res as usize;
        c.last_active = now;
        self.parse(idx);
        self.flush(idx);
        let Some(c) = self.conns[idx].as_mut() else {
            return;
        };
        // Start (or clear) the request timer for whatever is still unparsed.
        c.partial_since = if c.filled == 0 {
            None
        } else {
            c.partial_since.or(Some(now))
        };
        if !c.closing && !c.close_after_drain {
            self.arm_recv(idx);
        }
    }

    /// Parse every complete request in the receive buffer and add it to the batch.
    fn parse(&mut self, idx: usize) {
        let cfg = self.cfg;
        let c = self.conns[idx].as_mut().unwrap();
        let mut off = 0;
        // Bytes we need buffered to make progress (for large bodies).
        let mut need = 0;
        while !c.close_after_drain && off < c.filled {
            let data = &c.rbuf[off..c.filled];
            let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
            let mut req = httparse::Request::new(&mut headers);
            let hlen = match req.parse(data) {
                Ok(httparse::Status::Complete(n)) => n,
                Ok(httparse::Status::Partial) => {
                    if c.filled - off >= MAX_HEADER_BYTES {
                        reject(c, 431, &self.date);
                    }
                    break;
                }
                Err(httparse::Error::TooManyHeaders) => {
                    reject(c, 431, &self.date);
                    break;
                }
                Err(_) => {
                    reject(c, 400, &self.date);
                    break;
                }
            };

            let mut body_len: Option<usize> = None;
            let mut close = req.version == Some(0);
            let mut error = None;
            let mut has_host = false;
            for h in req.headers.iter() {
                if h.name.eq_ignore_ascii_case("host") {
                    has_host = true;
                } else if h.name.eq_ignore_ascii_case("content-length") {
                    let n = std::str::from_utf8(h.value)
                        .ok()
                        .and_then(|s| s.trim().parse().ok());
                    match (n, body_len) {
                        // Conflicting duplicate Content-Length is a request smuggling vector.
                        (Some(n), Some(prev)) if n != prev => error = Some(400),
                        (Some(n), _) => body_len = Some(n),
                        (None, _) => error = Some(400),
                    }
                } else if h.name.eq_ignore_ascii_case("transfer-encoding") {
                    // Chunked request bodies are not supported yet.
                    error = Some(411);
                } else if h.name.eq_ignore_ascii_case("connection") {
                    let v = h.value.to_ascii_lowercase();
                    if v.windows(5).any(|w| w == b"close") {
                        close = true;
                    } else if v.windows(10).any(|w| w == b"keep-alive") {
                        close = false;
                    }
                }
            }
            // RFC 9112 §3.2: an HTTP/1.1 request without Host must get a 400.
            if req.version == Some(1) && !has_host {
                error = error.or(Some(400));
            }
            let body_len = body_len.unwrap_or(0);
            if body_len > cfg.max_body {
                error = Some(413);
            }
            if let Some(status) = error {
                reject(c, status, &self.date);
                break;
            }

            let total = hlen + body_len;
            if data.len() < total {
                need = total;
                break;
            }

            let seq = c.next_req_seq;
            c.next_req_seq = seq.wrapping_add(1);
            let method = req.method.unwrap_or("GET");
            let headers = cfg.want_headers.then(|| {
                let mut flat = Vec::with_capacity(req.headers.len() * 2);
                for h in req.headers.iter() {
                    flat.push(h.name.to_ascii_lowercase());
                    flat.push(String::from_utf8_lossy(h.value).into_owned());
                }
                flat
            });
            self.batch.push(Request {
                id: make_id(idx, c.gen, seq, method == "HEAD") as f64,
                method: method.to_owned(),
                url: req.path.unwrap_or("/").to_owned(),
                headers,
                body: (body_len > 0).then(|| data[hlen..total].to_vec()),
            });
            off += total;
            if close {
                c.close_after_drain = true;
            }
        }

        // Shift unparsed bytes to the front and make room for what is still missing.
        if off > 0 {
            c.rbuf.copy_within(off..c.filled, 0);
            c.filled -= off;
        }
        let want = need.max(if c.filled == c.rbuf.len() {
            c.rbuf.len() * 2
        } else {
            0
        });
        if want > c.rbuf.len() {
            c.rbuf.resize(want, 0);
        }
    }

    fn on_wake(&mut self) {
        let resps = std::mem::take(&mut *self.shared.queue.lock().unwrap());
        for r in resps {
            let (idx, gen, seq, head) = split_id(r.id);
            let Some(Some(c)) = self.conns.get_mut(idx) else {
                continue;
            };
            if c.gen != gen || c.closing {
                continue; // connection went away while JS was working
            }
            let mut bytes = Vec::new();
            http::encode(
                &mut bytes,
                r.status,
                r.ctype,
                r.headers.as_deref(),
                &r.body,
                head,
                &self.date,
            );
            c.deliver(seq, bytes);
            self.flush(idx);
        }
    }

    /// Once a second: refresh the Date header and enforce timeouts.
    fn on_tick(&mut self) {
        self.date = http_date();
        let (now, idle, request) = (self.now, self.cfg.idle_timeout, self.cfg.request_timeout);
        for idx in 0..self.conns.len() {
            let Some(c) = self.conns[idx].as_mut() else {
                continue;
            };
            // Never time out a connection that is waiting on the app.
            if c.closing || c.close_after_drain || !c.drained() {
                continue;
            }
            match c.partial_since {
                // Slow or stalled request (slowloris): answer 408 and close.
                Some(t) if !request.is_zero() && now - t >= request => {
                    reject(c, 408, &self.date);
                    self.flush(idx);
                }
                None if !idle.is_zero() && now - c.last_active >= idle => self.close_conn(idx),
                _ => {}
            }
        }
    }

    /// Start a send if one is not already running; close drained `Connection: close` conns.
    fn flush(&mut self, idx: usize) {
        let Some(c) = self.conns[idx].as_mut() else {
            return;
        };
        if c.closing || c.send_inflight {
            return;
        }
        if c.out.is_empty() {
            if c.close_after_drain && c.drained() {
                self.close_conn(idx);
            }
            return;
        }
        std::mem::swap(&mut c.sending, &mut c.out);
        c.out.clear();
        c.sent = 0;
        self.submit_send(idx);
    }

    fn submit_send(&mut self, idx: usize) {
        let c = self.conns[idx].as_mut().unwrap();
        let rest = &c.sending[c.sent..];
        let e = opcode::Send::new(types::Fd(c.fd), rest.as_ptr(), rest.len() as u32)
            .flags(libc::MSG_NOSIGNAL)
            .build()
            .user_data(ud(OP_SEND, idx));
        c.send_inflight = true;
        push(&mut self.ring, &e);
    }

    fn on_send(&mut self, idx: usize, res: i32) {
        let now = self.now;
        let Some(c) = self.conns[idx].as_mut() else {
            return;
        };
        c.send_inflight = false;
        if res < 0 || c.closing {
            self.close_conn(idx);
            return;
        }
        c.last_active = now;
        c.sent += res as usize;
        if c.sent < c.sending.len() {
            self.submit_send(idx);
            return;
        }
        c.sending.clear();
        self.flush(idx);
    }

    /// Begin closing. shutdown() makes any in-flight recv/send complete, and the
    /// slot is only freed once nothing in the kernel still points at its buffers.
    fn close_conn(&mut self, idx: usize) {
        let Some(c) = self.conns[idx].as_mut() else {
            return;
        };
        if !c.closing {
            c.closing = true;
            unsafe { libc::shutdown(c.fd, libc::SHUT_RDWR) };
        }
        if !c.recv_inflight && !c.send_inflight {
            unsafe { libc::close(c.fd) };
            self.conns[idx] = None;
            self.free.push(idx);
            self.active -= 1;
        }
    }

    fn shutdown(&mut self) {
        unsafe {
            libc::shutdown(self.lfd, libc::SHUT_RDWR);
            libc::close(self.lfd);
        }
        for c in self.conns.iter().flatten() {
            unsafe {
                libc::shutdown(c.fd, libc::SHUT_RDWR);
                libc::close(c.fd);
            }
        }
        // Let the kernel finish cancelled ops before the buffers are dropped.
        let _ = self.ring.submit_and_wait(0);
    }
}

/// Answer the next request slot with a server-generated error and close afterwards.
fn reject(c: &mut Conn, status: u16, date: &str) {
    let seq = c.next_req_seq;
    c.next_req_seq = seq.wrapping_add(1);
    c.close_after_drain = true;
    c.deliver(seq, http::error(status, date));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_roundtrip_fits_in_js_number() {
        let id = make_id(MAX_CONNS - 1, u16::MAX, u16::MAX, true);
        assert!(id < (1u64 << 53));
        assert_eq!(
            split_id((id as f64) as u64),
            (MAX_CONNS - 1, u16::MAX, u16::MAX, true)
        );
        assert_eq!(split_id(make_id(5, 2, 3, false)), (5, 2, 3, false));
    }

    #[test]
    fn deliver_reorders_and_ignores_stale() {
        let mut c = Conn::new(-1, 1, Instant::now());
        c.next_req_seq = 3;
        c.deliver(2, b"c".to_vec());
        c.deliver(1, b"b".to_vec());
        assert!(c.out.is_empty());
        c.deliver(0, b"a".to_vec());
        assert_eq!(c.out, b"abc");
        c.deliver(1, b"dup".to_vec());
        assert_eq!(c.out, b"abc");
        assert_eq!(c.outstanding(), 0);
    }
}
