/**
 * The server, for every environment.
 *
 * Vercel detects a `server.*` entrypoint at the project root, captures the
 * listener, and routes all requests to it as a single Vercel Function. The same
 * file runs under Bun locally (`bun start`) because it is plain node:http —
 * nothing Bun-specific lives in here.
 *
 * Static files: on Vercel these are served from `public/**` by the CDN before a
 * request ever reaches this function. Locally there is no CDN, so we serve them
 * from disk as well. Either way the same URLs work.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { handleApi } from "./src/app";
import { sweepExpiredSessions } from "./src/auth";

// Vercel sets PORT; the default is only for local runs.
const PORT = Number(process.env.PORT ?? 4321);
const PUBLIC_DIR = resolve(process.cwd(), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** node:http request -> web Request, so the router stays runtime-agnostic. */
async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const method = req.method ?? "GET";
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length) {
      // Copy out of the pooled Buffer — .buffer alone is the whole shared pool.
      const buf = Buffer.concat(chunks);
      body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((one) => headers.append(k, one));
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(url, { method, headers, body });
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = {};
  // Several Set-Cookie headers must stay separate rather than being joined.
  const cookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  });
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Read a file from public/, refusing anything that resolves outside it. */
async function staticFile(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + "/") && target !== PUBLIC_DIR) return null;
  try {
    if (!(await stat(target)).isFile()) return null;
    return new Response(await readFile(target), {
      headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" },
    });
  } catch {
    return null; // not there, or not readable — fall through
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(await toWebRequest(req, url));
      return await send(res, response ?? new Response("Not found", { status: 404 }));
    }
    const file = await staticFile(url.pathname);
    if (file) return await send(res, file);

    // Unknown path: hand back the app shell if we have it, otherwise 404.
    const shell = await staticFile("/index.html");
    return await send(res, shell ?? new Response("Not found", { status: 404 }));
  } catch (err) {
    console.error("[server]", req.method, url.pathname, err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Something went wrong on the server." }));
  }
});

server.listen(PORT, () => {
  console.log(`knoknok listening on http://localhost:${PORT}`);
});

// Instances live long enough to be worth a periodic tidy; unref'd so it never
// holds the process open.
sweepExpiredSessions().catch(() => {});
setInterval(() => void sweepExpiredSessions().catch(() => {}), 60 * 60 * 1000).unref();
