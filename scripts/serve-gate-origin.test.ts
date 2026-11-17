import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { existsSync } from "node:fs";

import { fillPageConfig, policyPageFile } from "./serve-gate-origin";

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
