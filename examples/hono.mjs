// Run a Hono app on ringwire:  npm install hono && node examples/hono.mjs
// Any framework that exposes a Fetch API handler (Request -> Response) works the same way.
import { Hono } from 'hono';
import { serve } from 'ringwire';

const app = new Hono();
app.get('/', (c) => c.text('Hello from Hono on io_uring!'));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }));
app.post('/echo', async (c) => c.json(await c.req.json()));

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
await server.ready;
console.log(`listening on :${server.port} (${server.backend})`);
