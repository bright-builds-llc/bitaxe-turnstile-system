import { resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const relativePath = pathname === "/" ? "README.md" : `.${pathname}`;
    const filePath = resolve(repositoryRoot, relativePath);
    if (filePath !== repositoryRoot && !filePath.startsWith(`${repositoryRoot}${sep}`)) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});

process.stdout.write(`${server.port}\n`);
