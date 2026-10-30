// A small JSON API with routing, path params and request bodies.
// No framework: a Map lookup plus one regex keeps the hot path cheap.
const { createServer, reply } = require('ringwire');

const posts = new Map([[1, { id: 1, author: 'ana', text: 'first post', likes: 0 }]]);
let nextId = 2;

function parseJson(body) {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return undefined;
  }
}

const routes = {
  'GET /posts': () => [...posts.values()],
  'POST /posts': (req) => {
    const input = parseJson(req.body);
    if (!input || typeof input.text !== 'string') return reply(422, { error: 'text is required' });
    const post = { id: nextId++, author: input.author ?? 'anon', text: input.text, likes: 0 };
    posts.set(post.id, post);
    return reply(201, post);
  },
};

const postRoute = /^\/posts\/(\d+)(\/like)?$/;

createServer(
  (req) => {
    const path = req.url.split('?', 1)[0];
    const exact = routes[`${req.method} ${path}`];
    if (exact) return exact(req);

    const m = postRoute.exec(path);
    if (m) {
      const post = posts.get(Number(m[1]));
      if (!post) return reply(404, { error: 'no such post' });
      if (m[2] && req.method === 'POST') {
        post.likes++;
        return post;
      }
      if (!m[2] && req.method === 'GET') return post;
      return reply(405, { error: 'method not allowed' });
    }
    return reply(404, { error: 'not found' });
  },
  { port: Number(process.env.PORT ?? 3000) },
);
