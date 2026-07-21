import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ConfigStore } from "./config-store.js";
import { createControlApi } from "./control-api.js";
import { createProxyHandlers } from "./proxy.js";
import {
  embeddedContentType,
  getEmbeddedAsset,
} from "./embedded-public.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  store: ConfigStore;
}

export interface RunningServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

function resolvePublicDir(): string | null {
  const candidates: string[] = [];
  try {
    if (process.execPath) {
      candidates.push(join(dirname(process.execPath), "public"));
    }
  } catch {
    // ignore
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(
      join(here, "..", "public"),
      join(here, "..", "..", "public"),
    );
  } catch {
    // ignore
  }
  candidates.push(
    join(process.cwd(), "public"),
    join(process.cwd(), "dist", "public"),
  );
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

function readDiskAsset(publicDir: string | null, path: string): string | null {
  if (!publicDir) return null;
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  const full = join(publicDir, rel);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

function resolveAsset(path: string, publicDir: string | null): string | null {
  return getEmbeddedAsset(path) ?? readDiskAsset(publicDir, path);
}

function etagFor(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;
}

function staticResponse(
  body: string,
  path: string,
  inm: string | undefined,
): Response {
  const etag = etagFor(body);
  if (inm && inm === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "public, max-age=60",
      },
    });
  }
  const isHtml = path === "/" || path.endsWith(".html");
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": embeddedContentType(path),
      ETag: etag,
      // HTML short cache; assets can sit longer (rev via etag)
      "Cache-Control": isHtml
        ? "public, max-age=15"
        : "public, max-age=300",
    },
  });
}

export function createApp(store: ConfigStore): Hono {
  const app = new Hono();
  const { handleModels, handleProxy } = createProxyHandlers(store);
  const publicDir = resolvePublicDir();

  // Local-only gateway: skip full CORS preflight machinery for same-origin UI.
  // Still allow simple cross-origin tools on loopback if needed.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Access-Control-Allow-Origin", "*");
    c.res.headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    c.res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  });
  app.options("*", (c) => c.body(null, 204));

  app.route("/api", createControlApi(store));

  app.get("/v1/models", handleModels);
  app.all("/v1/*", handleProxy);

  const servePath = (path: string) => (c: { req: { header: (n: string) => string | undefined }; html: (s: string) => Response; notFound: () => Response }) => {
    const body =
      resolveAsset(path, publicDir) ??
      (path === "/" ? resolveAsset("/index.html", publicDir) : null);
    if (!body) {
      if (path === "/" || path.endsWith(".html")) {
        return c.html(fallbackHtml());
      }
      return c.notFound();
    }
    return staticResponse(body, path, c.req.header("if-none-match"));
  };

  // lighter typing via any for hono context compatibility
  app.get("/", (c) => {
    const body =
      resolveAsset("/", publicDir) ?? resolveAsset("/index.html", publicDir);
    if (!body) return c.html(fallbackHtml());
    return staticResponse(body, "/", c.req.header("if-none-match"));
  });
  app.get("/index.html", (c) => {
    const body = resolveAsset("/index.html", publicDir);
    if (!body) return c.html(fallbackHtml());
    return staticResponse(body, "/index.html", c.req.header("if-none-match"));
  });
  app.get("/app.js", (c) => {
    const body = resolveAsset("/app.js", publicDir);
    if (!body) return c.notFound();
    return staticResponse(body, "/app.js", c.req.header("if-none-match"));
  });
  app.get("/styles.css", (c) => {
    const body = resolveAsset("/styles.css", publicDir);
    if (!body) return c.notFound();
    return staticResponse(body, "/styles.css", c.req.header("if-none-match"));
  });
  void servePath;

  app.notFound((c) => {
    if (c.req.path.startsWith("/api") || c.req.path.startsWith("/v1")) {
      return c.json(
        { error: { message: "Not found", type: "not_found" } },
        404,
      );
    }
    const asset = resolveAsset(c.req.path, publicDir);
    if (asset != null) {
      return staticResponse(
        asset,
        c.req.path,
        c.req.header("if-none-match"),
      );
    }
    const html = resolveAsset("/index.html", publicDir);
    if (html) return staticResponse(html, "/index.html", c.req.header("if-none-match"));
    return c.html(fallbackHtml());
  });

  return app;
}

function fallbackHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>GBG</title></head>
<body style="font-family:system-ui;padding:2rem;background:#0b0f14;color:#e8eef7">
<h1>GrokBuild Gateway</h1>
<p>API up. UI assets missing.</p>
<ul>
<li><a href="/api/health">/api/health</a></li>
<li><a href="/api/snapshot">/api/snapshot</a></li>
<li><a href="/v1/models">/v1/models</a></li>
</ul>
</body></html>`;
}

export async function startServer(
  options: ServeOptions,
): Promise<RunningServer> {
  const cfg = options.store.get();
  const host = options.host ?? cfg.server.host ?? "127.0.0.1";
  const port = options.port ?? cfg.server.port ?? 8787;

  // Protect loopback + optional upstream direct mode before any outbound work
  const { applyProxyShield } = await import("../lib/proxy-shield.js");
  const { isGlobalProxyShieldOn, proxyModeFromShield } = await import("./types.js");
  applyProxyShield(proxyModeFromShield(isGlobalProxyShieldOn(cfg.server)));

  if (host !== cfg.server.host || port !== cfg.server.port) {
    options.store.update((c) => {
      c.server.host = host;
      c.server.port = port;
      return c;
    });
  }

  options.store.startWatch();
  const app = createApp(options.store);

  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: host,
          port,
        },
        (info) => {
          resolve({
            host,
            port: info.port,
            close: () =>
              new Promise((res, rej) => {
                server.close((err) => (err ? rej(err) : res()));
              }),
          });
        },
      );
      server.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
