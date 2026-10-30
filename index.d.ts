/// <reference types="node" />

export interface Request {
  /** Opaque id the server uses to route the response back. */
  readonly id: number;
  readonly method: string;
  /** Path and query string exactly as sent, e.g. `/users/1?full=true`. */
  readonly url: string;
  /**
   * Flat `[name, value, name, value, ...]` list with lowercased names.
   * `null` unless the server was created with `headers: true`.
   */
  readonly headers: string[] | null;
  /** Request body, or `null` when there is none. */
  readonly body: Buffer | null;
}

/** What a handler may return. Objects and arrays are sent as JSON. */
export type Body = string | Buffer | Uint8Array | object | null | undefined;

export type ContentType = 'json' | 'text' | 'html' | 'binary';

export type OutgoingHeaders = Record<string, string | number | Array<string | number> | null | undefined>;

export interface ReplyOptions {
  /** Default content-type when no `content-type` header is given. */
  type?: ContentType;
  headers?: OutgoingHeaders;
}

export interface Reply {
  readonly status: number;
  readonly body: Body;
}

export type HandlerResult = Body | Reply;
export type Handler = (req: Request) => HandlerResult | Promise<HandlerResult>;

export interface ServerOptions {
  /** Port to listen on (default 3000; 0 picks a free port). */
  port?: number;
  /** Address to bind (default `0.0.0.0`). */
  host?: string;
  /** io_uring worker threads (default 1). Ignored by the node backend. */
  threads?: number;
  /** Pass request headers to handlers (default false; costs a little per request). */
  headers?: boolean;
  /** Close keep-alive connections idle for this many ms (default 5000, 0 = never). */
  idleTimeout?: number;
  /** Max ms to receive a complete request once it starts (default 30000, 0 = never). */
  requestTimeout?: number;
  /** Largest accepted request body in bytes (default 8 MiB). */
  maxBodySize?: number;
  /** Max open connections (per worker thread for io_uring). */
  maxConnections?: number;
  /**
   * `auto` (default) uses io_uring when available and falls back to node:http otherwise.
   * `io_uring` throws instead of falling back; `node` always uses node:http.
   */
  backend?: 'auto' | 'io_uring' | 'node';
}

export interface Server {
  /** Which backend is serving requests. */
  readonly backend: 'io_uring' | 'node';
  /** Bound port (resolved after `ready` when the node backend listens on port 0). */
  readonly port: number;
  /** Resolves once the server accepts connections. */
  readonly ready: Promise<void>;
  /** Stop accepting, close all connections. */
  close(): Promise<void>;
}

export function createServer(handler: Handler, options?: ServerOptions): Server;

export interface ServeOptions extends Omit<ServerOptions, 'headers'> {
  /** A Fetch API handler, e.g. `app.fetch` from Hono. */
  fetch: (request: globalThis.Request) => globalThis.Response | Promise<globalThis.Response>;
}

/** Serve a Fetch API handler (Request -> Response), e.g. `serve({ fetch: app.fetch })`. */
export function serve(options: ServeOptions): Server;

export function reply(status: number, body?: Body, options?: ContentType | ReplyOptions): Reply;
