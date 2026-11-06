#!/usr/bin/env bun
/**
 * Same-origin HTTPS front for the production-path rehearsal (Ticket 06).
 *
 * Serves the repository's static files and streams the `gate-authority` and
 * `reference-service` routes, so the page, its event stream and its proofs all
 * name one origin. Rehearsal only; it uses a throwaway
 * self-signed certificate.
 */
import { resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const gate = required("BWG_REHEARSAL_GATE");
const reference = required("BWG_REHEARSAL_REFERENCE");
const port = Number(required("BWG_REHEARSAL_FRONT_PORT"));
const config = required("BWG_REHEARSAL_CONFIG_JSON");
const authorityPaths = /^\/(v0|\.well-known)(\/|$)/u;
const referencePaths = /^\/account-creation(\/|$)/u;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: {
    cert: Bun.file(required("BWG_REHEARSAL_TLS_CERT")),
    key: Bun.file(required("BWG_REHEARSAL_TLS_KEY")),
  },
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (authorityPaths.test(url.pathname)) return await forward(gate, request, url);
    if (referencePaths.test(url.pathname)) return await forward(reference, request, url);
    if (url.pathname === "/rehearsal-config") {
      return new Response(config, { headers: { "content-type": "application/json" } });
    }
    return await staticFile(decodeURIComponent(url.pathname));
  },
});
process.stdout.write(`${port}\n`);

async function forward(service: string, request: Request, url: URL): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  const upstream = await fetch(`${service}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

async function staticFile(pathname: string): Promise<Response> {
  const filePath = resolve(repositoryRoot, `.${pathname}`);
  if (!filePath.startsWith(`${repositoryRoot}${sep}`)) return new Response("not found", { status: 404 });
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
