# Contributing to ringwire

Thanks for helping! Bug reports, benchmarks on your hardware and PRs are all welcome.

## Setup

You need Linux (io_uring), Rust stable and Node.js 18+.

```sh
git clone https://github.com/kichuu/ringwire && cd ringwire
npm run build          # builds the addon into ./ringwire.node
npm test               # JS tests, against both the io_uring and node:http backends
npm run test:rust      # Rust unit tests
```

On macOS you can still work on the JS side; the tests for the `node` backend run anywhere. For
io_uring, use a Linux VM or a container started with `--security-opt seccomp=unconfined`.

## Before opening a PR

- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` are clean.
- `npm test` passes. New behaviour comes with a test in `test/`; protocol behaviour belongs in
  `test/server.test.js` so both backends are checked.
- Performance changes include before/after numbers from `bench/run.sh` (same machine, same settings).
- Changes to `src/worker.rs` respect the buffer-lifetime rules in
  [docs/architecture.md](docs/architecture.md). Explain in the PR why any `unsafe` stays sound.

Keep PRs focused, one change per PR. For large features, open an issue first so we can agree on
the design before you invest the time.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `perf: ...`,
`docs: ...`, `test: ...`, `ci: ...`, `chore: ...`.

## Releasing (maintainers)

```sh
npm version minor      # bumps version and syncs npm/* platform packages
git push --follow-tags # CI builds 4 binaries, tests them, publishes to npm, creates the release
```
