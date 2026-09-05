#!/usr/bin/env bun
const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
});
const commit = result.stdout.toString().trim();
if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit))
  throw new Error("Gate source identity unavailable");
const build = await Bun.build({
  entrypoints: ["web/worker-serial-acceptance.ts"],
  target: "browser",
  format: "esm",
  outdir: "dist/worker-serial-acceptance",
  define: { BWG_GATE_SOURCE_COMMIT: JSON.stringify(commit) },
});
if (!build.success)
  throw new AggregateError(build.logs, "Worker acceptance build failed");
