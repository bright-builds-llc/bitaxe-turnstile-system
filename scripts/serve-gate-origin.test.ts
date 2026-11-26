import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { existsSync } from "node:fs";

import { fillPageConfig, operationalResponse, policyPageFile } from "./serve-gate-origin";

test("fills the reference page's config element", async () => {
  // Arrange
  const html = await readFile("reference/account-creation.html", "utf8");

  // Act
  const filled = fillPageConfig(html, '{"workers":[]}');

  // Assert
  expect(filled).toContain('<script type="application/json" id="bwg-reference-config">{"workers":[]}</script>');
});

test("escapes markup so config text cannot close the script", () => {
  // Arrange
  const html = '<script type="application/json" id="bwg-reference-config">null</script>';

  // Act
  const filled = fillPageConfig(html, '{"name":"</script><script>alert(1)</script>"}');

  // Assert
  expect(filled).not.toContain("</script><script>");
  expect(JSON.parse(filled.replace(/^.*?>/u, "").replace(/<\/script>$/u, ""))).toEqual({
    name: "</script><script>alert(1)</script>",
  });
});

test("refuses a page without an empty config element", () => {
  // Act
  const fill = () => fillPageConfig("<html></html>", "{}");

  // Assert
  expect(fill).toThrow("no empty config element");
});

test("maps each linked policy path to its page", () => {
  // Arrange
  const expected = {
    "/policies/operator": "reference/policies/operator.html",
    "/privacy": "reference/policies/privacy.html",
    "/terms": "reference/policies/terms.html",
  };

  // Act
  const mapped = Object.fromEntries(Object.keys(expected).map(path => [path, policyPageFile(path)]));

  // Assert
  expect(mapped).toEqual(expected);
  for (const file of Object.values(expected)) expect(existsSync(file)).toBe(true);
});

test("serves no other policy-like path", () => {
  // Arrange
  const nearMisses = ["/privacy/", "/terms.html", "/policies/", "/policies/operator.html", "/policies/../package.json"];

  // Act
  const mapped = nearMisses.map(path => policyPageFile(path));

  // Assert
  expect(mapped).toEqual(nearMisses.map(() => undefined));
});

const available = async () => ({ status: "available" as const });

test("answers health with 200 while the application is available", async () => {
  // Act
  const response = await operationalResponse("/healthz", { health: available, miningJob: async () => "no_job" });

  // Assert
  expect(response?.status).toBe(200);
});

test("answers health with 503 naming the part that is unavailable", async () => {
  // Act
  const response = await operationalResponse("/healthz", {
    health: async () => ({ status: "unavailable", part: "reference_service" }),
    miningJob: async () => "admitted_job",
  });

  // Assert
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({ status: "unavailable", part: "reference_service" });
});

test("answers readiness with 200 only once Hydra released an admitted job", async () => {
  // Act
  const response = await operationalResponse("/readyz", { health: available, miningJob: async () => "admitted_job" });

  // Assert
  expect(response?.status).toBe(200);
});

test("answers readiness with 503 while the application is healthy but no job is admitted", async () => {
  // Act
  const response = await operationalResponse("/readyz", { health: available, miningJob: async () => "no_job" });

  // Assert
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({ ready: false, application: "available", miningJob: "no_job" });
});

test("serves the deployment's provenance document", async () => {
  // Act
  const response = await operationalResponse("/provenance", {
    health: available,
    miningJob: async () => "admitted_job",
    maybeProvenance: '{"source":{"commit":"abc"}}',
  });

  // Assert
  expect(await response?.json()).toEqual({ source: { commit: "abc" } });
});

test("leaves every other path to the page routes", async () => {
  // Act
  const response = await operationalResponse("/reference/account-creation.html", {
    health: available,
    miningJob: async () => "admitted_job",
  });

  // Assert
  expect(response).toBeUndefined();
});
