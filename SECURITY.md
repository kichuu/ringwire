# Security Policy

ringwire parses untrusted network input in Rust with `unsafe` io_uring code, so we take reports
seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/kichuu/ringwire/security/advisories/new) with:

- what you found and its impact (crash, memory corruption, request smuggling, DoS, …)
- a minimal reproduction (raw request bytes are ideal)
- the ringwire version, Node.js version and kernel version

You can expect an acknowledgement within 72 hours and a fix or mitigation plan within 14 days for
confirmed issues. You will be credited in the release notes unless you prefer otherwise.

## Supported versions

While ringwire is 0.x, only the latest minor release receives security fixes.

## Hardening already in place

- Request/idle timeouts (slowloris), body and header size limits, connection limits
- Conflicting `Content-Length` rejected; chunked request bodies refused (no TE/CL ambiguity)
- `Host` required on HTTP/1.1
- Response header names/values validated (no CR/LF injection)
