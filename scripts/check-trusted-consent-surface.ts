import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [resolve(repositoryRoot, "web/trusted-consent-surface.ts")],
  target: "browser",
  format: "esm",
  write: false,
});
if (!result.success || result.outputs.length !== 1) {
  throw new Error("trusted-consent surface bundle failed");
}
const expected = await result.outputs[0]?.text();
const retained = await Bun.file(
  resolve(repositoryRoot, "web/generated/trusted-consent-surface.js"),
).text();
if (expected !== retained) {
  throw new Error("trusted-consent surface bundle is stale; run bun run build:browser");
}
