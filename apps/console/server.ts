import path from "node:path";

import index from "./index.html";

/**
 * Development server for the operator console. It serves the bundled UI, proxies /v1 to the
 * FORGE API, and — for the local demo only — exposes the seeded demonstration session so the
 * browser can act as each role's wallet. This process is not the API: the API never sees keys.
 */
const apiUrl = process.env.FORGE_API_URL ?? "http://127.0.0.1:3002";
const sessionPath =
  process.env.FORGE_DEMO_SESSION ??
  path.join(import.meta.dir, "../../.local/demo/session.json");
const port = Number(process.env.FORGE_CONSOLE_PORT ?? 3003);

async function proxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  try {
    const response = await fetch(`${apiUrl}${url.pathname}${url.search}`, {
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      headers,
      method: request.method,
    });
    return new Response(response.body, {
      headers: response.headers,
      status: response.status,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "api_unreachable",
          message: `FORGE API is not reachable at ${apiUrl}`,
        },
      },
      { status: 502 }
    );
  }
}

const server = Bun.serve({
  development: process.env.NODE_ENV === "production" ? false : { hmr: true },
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": index,
    "/dev/session": async () => {
      const file = Bun.file(sessionPath);
      if (!(await file.exists())) {
        return Response.json(
          {
            error:
              "No demo session. Seed one with: bun run --cwd apps/localnet seed",
          },
          { status: 404 }
        );
      }
      return new Response(file, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    },
    "/v1/*": proxy,
  },
});

console.log(
  `FORGE console on http://${server.hostname}:${server.port} → API ${apiUrl}`
);
