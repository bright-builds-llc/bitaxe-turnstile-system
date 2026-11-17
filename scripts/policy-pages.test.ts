import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { POLICY_PAGES } from "./serve-gate-origin";

const pages = Object.values(POLICY_PAGES).map(file => ({ file, html: readFileSync(file, "utf8") }));
const privacy = readFileSync(POLICY_PAGES["/privacy"]!, "utf8");
const terms = readFileSync(POLICY_PAGES["/terms"]!, "utf8");

test("every policy page opens with the draft banner", () => {
  // Act
  const bannerBeforeHeading = pages.map(({ file, html }) => {
    const banner = html.indexOf("Draft, not yet reviewed by the operator or a lawyer.");
    const heading = html.indexOf("<h1");
    return [file, banner >= 0 && heading > banner];
  });

  // Assert
  expect(bannerBeforeHeading).toEqual(pages.map(({ file }) => [file, true]));
});

test("every policy page loads nothing remote", () => {
  // Act
  const remote = pages.filter(({ html }) => /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(html) || html.includes("@import"));

  // Assert
  expect(remote.map(({ file }) => file)).toEqual([]);
});

test("the privacy page says the pool receives the payout address", () => {
  // Assert
  expect(privacy).toContain("sent to the pool as the miner's Stratum username");
});

test("the privacy page promises no deletion it can't keep", () => {
  // Arrange
  const retention = privacy.slice(privacy.indexOf('id="retention"'));

  // Assert
  expect(privacy).toContain('id="retention"');
  expect(retention).toContain("[Owner:");
  expect(privacy).not.toContain("automatically deleted");
});

test("the terms page says the Gate doesn't verify the pool's block reward", () => {
  // Assert
  expect(terms).toContain("the Gate doesn't verify the pool's block template");
});

test("the privacy page states retention as eligibility, not as deletion done", () => {
  // Assert
  expect(privacy).not.toMatch(/are deleted once they expire|record is deleted at day 90/u);
});

test("the privacy page limits the 30 and 90 day schedule to the Gate Authority's own records", () => {
  // Assert
  expect(privacy).toContain("The Gate Authority's challenge, share");
});

test("the terms page doesn't guarantee the device's return to mining", () => {
  // Assert
  expect(terms).not.toContain("as it was before");
});

test("the privacy page claims no absolute non-sharing", () => {
  // Assert
  expect(privacy).not.toContain("shares nothing else with anyone");
});

test("the privacy page implies no account removal step that doesn't exist", () => {
  // Assert
  expect(privacy).not.toContain("kept until removed");
});
