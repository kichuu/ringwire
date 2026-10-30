// Bun.serve with static routes (no per-request URL parsing).
Bun.serve({
  port: Number(process.env.PORT),
  routes: {
    '/plaintext': () => new Response('Hello, World!', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    '/json': () => Response.json({ message: 'Hello, World!' }),
  },
  fetch: () => new Response(null, { status: 404 }),
});
