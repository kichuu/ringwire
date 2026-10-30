const http = require('node:http');

http
  .createServer((req, res) => {
    if (req.url === '/plaintext') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 13 });
      return res.end('Hello, World!');
    }
    if (req.url === '/json') {
      const body = JSON.stringify({ message: 'Hello, World!' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404).end();
  })
  .listen(Number(process.env.PORT));
