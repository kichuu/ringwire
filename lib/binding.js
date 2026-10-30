'use strict';

// Locate the native addon: a local dev build (`npm run build`) wins, otherwise
// the prebuilt package npm installed for this platform as an optional dependency.
// Never throws: callers decide whether a missing binding is fatal.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

function libc() {
  const report = process.report && process.report.getReport();
  const header = typeof report === 'string' ? JSON.parse(report).header : report && report.header;
  return header && header.glibcVersionRuntime ? 'gnu' : 'musl';
}

function load() {
  const local = join(__dirname, '..', 'ringwire.node');
  if (existsSync(local)) return { binding: require(local), error: null };

  if (process.platform !== 'linux') {
    return { binding: null, error: new Error(`io_uring is Linux-only (running on ${process.platform})`) };
  }
  const pkg = `ringwire-linux-${process.arch}-${libc()}`;
  try {
    return { binding: require(pkg), error: null };
  } catch (cause) {
    const error = new Error(
      `no prebuilt binary for linux-${process.arch}-${libc()} (tried "${pkg}"); ` +
        'reinstall without --omit=optional or build from source with `npm run build`',
    );
    error.cause = cause;
    return { binding: null, error };
  }
}

module.exports = load();
