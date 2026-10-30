const { createServer } = require('../..');

createServer(
  (req) => {
    if (req.url === '/plaintext') return 'Hello, World!';
    if (req.url === '/json') return { message: 'Hello, World!' };
    return null;
  },
  { port: Number(process.env.PORT), threads: Number(process.env.THREADS ?? 1) },
);
