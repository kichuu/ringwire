# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- io_uring HTTP/1.1 server core in Rust: multishot accept, keep-alive, pipelining with in-order
  responses, one JS↔native crossing per batch, multiple worker threads via `SO_REUSEPORT`.
- `createServer(handler, options)` with string, JSON, Buffer, `reply()` and Promise results.
- Custom response headers (validated against CR/LF injection), `Date` header, correct `HEAD`.
- Idle and request timeouts, `maxBodySize`, `maxConnections`, `Host` enforcement and conflicting
  `Content-Length` rejection.
- Automatic `node:http` fallback where io_uring is unavailable (macOS, Windows, Docker default seccomp).
- `serve({ fetch })` for Fetch API frameworks such as Hono.
- TypeScript types, ESM and CJS entry points, prebuilt binaries for linux x64/arm64 (glibc and musl).
