#!/usr/bin/env bun
/**
 * Same-origin front for a Gate deployment (Ticket 07). It listens on loopback over
 * plain HTTP; `tailscale serve` terminates TLS in front of it. It routes `/v0` and
 * `/.well-known` to `gate-authority` and `/account-creation` to
 * `reference-service`. It serves only the reference page, with its public config
 * filled in, and that page's bundle; every other path is 404.
 *
 * Environment: BWG_FRONT_PORT, BWG_FRONT_GATE and BWG_FRONT_REFERENCE (http
 * base URLs), and BWG_FRONT_PAGE_CONFIG_FILE (the page config JSON).
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const PAGE_PATH = "/reference/account-creation.html";
const BUNDLE_PREFIX = "/dist/reference-page/";
const CONFIG_PLACEHOLDER = '<script type="application/json" id="bwg-reference-config">null</script>';
const authorityPaths = /^\/(v0|\.well-known)(\/|$)/u;
const referencePaths = /^\/account-creation(\/|$)/u;

/** Fills the page's config element; `<` is escaped so the JSON cannot close the script. */
export function fillPageConfig(html: string, configJson: string): string {
  if (!html.includes(CONFIG_PLACEHOLDER)) throw new Error("the page has no empty config element");
  const safeJson = JSON.stringify(JSON.parse(configJson)).replaceAll("<", "\\u003c");
  return html.replace(
    CONFIG_PLACEHOLDER,
    `<script type="application/json" id="bwg-reference-config">${safeJson}</script>`,
  );
}

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

async function bundleFile(pathname: string): Promise<Response> {
  const name = pathname.slice(BUNDLE_PREFIX.length);
  if (name !== basename(name) || name.startsWith(".")) return new Response("not found", { status: 404 });
  const file = Bun.file(resolve(repositoryRoot, "dist/reference-page", name));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.main) {
  const gate = required("BWG_FRONT_GATE");
  const reference = required("BWG_FRONT_REFERENCE");
  const port = Number(required("BWG_FRONT_PORT"));
  const page = fillPageConfig(
    await readFile(resolve(repositoryRoot, `.${PAGE_PATH}`), "utf8"),
    await readFile(required("BWG_FRONT_PAGE_CONFIG_FILE"), "utf8"),
  );
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (authorityPaths.test(url.pathname)) return await forward(gate, request, url);
      if (referencePaths.test(url.pathname)) return await forward(reference, request, url);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      if (url.pathname === "/") return new Response(null, { status: 302, headers: { location: PAGE_PATH } });
      if (url.pathname === PAGE_PATH) {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname.startsWith(BUNDLE_PREFIX)) return await bundleFile(url.pathname);
      return new Response("not found", { status: 404 });
    },
  });
  process.stdout.write(`${port}\n`);
}
