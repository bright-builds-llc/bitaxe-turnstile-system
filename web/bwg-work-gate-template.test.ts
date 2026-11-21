import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the consent terms show each field Core MVP criterion 4 names", () => {
  // Arrange
  const template = readFileSync("web/bwg-work-gate.template.html", "utf8");
  const criterionFields = [
    ["Expected hashes", "work"],
    ["Equivalent binary-zero work", "bits"],
    ["Selected-destination allocation", "reward"],
    ["Payout Destination", "payout"],
    ["Workers", "workers"],
    ["Estimated duration", "duration"],
  ];

  // Act
  const missing = criterionFields.filter(
    ([label, field]) => !template.includes(`<dt>${label}</dt><dd data-field="${field}"></dd>`),
  );

  // Assert
  expect(missing).toEqual([]);
});
