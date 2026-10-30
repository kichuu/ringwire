'use strict';

const net = require('node:net');

/**
 * Open a raw TCP connection, write `payload` and collect the response until
 * the server closes the socket or `timeout` ms pass.
 * `payload` may be a string/Buffer, or an array of chunks written 2ms apart.
 */
function exchange(port, payload, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    const done = (closed) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      resolve({ raw, data: raw.toString('latin1'), closed });
    };
    const timer = setTimeout(() => {
      sock.destroy();
      done(false);
    }, timeout);
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => done(true));
    sock.on('error', (e) => (e.code === 'ECONNRESET' ? done(true) : reject(e)));
    if (!Array.isArray(payload)) return sock.write(payload);
    let i = 0;
    const iv = setInterval(() => {
      if (sock.destroyed) return clearInterval(iv);
      sock.write(payload[i++]);
      if (i === payload.length) clearInterval(iv);
    }, 2);
  });
}

const get = (path, extra = '') => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const close = 'Connection: close\r\n';
const bodyOf = (data) => data.slice(data.indexOf('\r\n\r\n') + 4);
const headerOf = (data, name) => {
  const m = data.match(new RegExp(`^${name}: (.*)$`, 'mi'));
  return m ? m[1].trim() : undefined;
};

module.exports = { exchange, get, close, bodyOf, headerOf };
