// Prebuilt targets. Each becomes an npm package `alacrity-http-<name>`.
module.exports = [
  { name: 'linux-x64-gnu', target: 'x86_64-unknown-linux-gnu', cpu: 'x64', libc: 'glibc' },
  { name: 'linux-arm64-gnu', target: 'aarch64-unknown-linux-gnu', cpu: 'arm64', libc: 'glibc' },
  { name: 'linux-x64-musl', target: 'x86_64-unknown-linux-musl', cpu: 'x64', libc: 'musl' },
  { name: 'linux-arm64-musl', target: 'aarch64-unknown-linux-musl', cpu: 'arm64', libc: 'musl' },
];
