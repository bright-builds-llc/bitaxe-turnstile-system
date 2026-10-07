#!/usr/bin/env bun
const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
});
const commit = result.stdout.toString().trim();
if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit))
  throw new Error("Gate source identity unavailable");
// Each local qualification page is its own self-contained bundle bound to the same Gate source commit.
for (const [entrypoint, outdir] of [
  ["web/worker-serial-acceptance.ts", "dist/worker-serial-acceptance"],
  ["web/worker-restoration-page.ts", "dist/worker-restoration"],
] as const) {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    outdir,
    define: { BWG_GATE_SOURCE_COMMIT: JSON.stringify(commit) },
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Worker acceptance build failed");
}
