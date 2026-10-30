// node examples/hello.js   (PORT=3000 THREADS=1 by default)
const { createServer, reply } = require('ringwire');

const server = createServer(
  (req) => {
    switch (req.url) {
      case '/':
        return 'Hello, World!';
      case '/json':
        return { message: 'Hello, World!' };
      case '/echo':
        return req.method === 'POST' ? req.body : reply(405, 'POST only');
      case '/later':
        return new Promise((resolve) => setTimeout(() => resolve({ waited: 20 }), 20));
      case '/old':
        return reply(301, null, { headers: { location: '/' } });
      default:
        return reply(404, 'Not Found');
    }
  },
  { port: Number(process.env.PORT ?? 3000), threads: Number(process.env.THREADS ?? 1) },
);

server.ready.then(() => console.log(`listening on :${server.port} (${server.backend})`));
process.on('SIGINT', () => server.close().then(() => process.exit(0)));
