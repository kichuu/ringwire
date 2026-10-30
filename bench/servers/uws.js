// uWebSockets.js (install: cd bench && npm install; needs Node 22+).
// Plain handlers, no microcaching, same work per request as the other servers.
const uWS = require('uWebSockets.js');

uWS
  .App()
  .get('/plaintext', (res) => {
    res.writeHeader('content-type', 'text/plain; charset=utf-8').end('Hello, World!');
  })
  .get('/json', (res) => {
    res.writeHeader('content-type', 'application/json').end(JSON.stringify({ message: 'Hello, World!' }));
  })
  .any('/*', (res) => {
    res.writeStatus('404 Not Found').end();
  })
  .listen(Number(process.env.PORT), (token) => {
    if (!token) process.exit(1);
  });
