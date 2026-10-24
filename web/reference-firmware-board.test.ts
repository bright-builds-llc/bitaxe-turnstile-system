import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";

import controllerSchema from "../conformance/bwg-worker-controller-0.4/contract.schema.json";
import controllerFixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import usbSchema from "../conformance/bwg-worker-serial-0.2/contract.schema.json";
import trustSchema from "../conformance/bwg-worker-deployment-trust-0.2/contract.schema.json";
import trustFixtures from "../conformance/bwg-worker-deployment-trust-0.2/fixtures.json";
import {
  REFERENCE_FIRMWARE_BOARDS,
  maybeReferenceFirmwareBoard,
  maybeReferenceFirmwareBoardByRevision,
} from "./reference-firmware-board";

const admitted = [
  ["bitaxe-ultra", "205"],
  ["bitaxe-gamma", "601"],
] as const;
const refused = [
  ["bitaxe-gamma", "204"],
  ["bitaxe-ultra", "601"],
  ["bitaxe-gamma", "205"],
  ["bitaxe-max", "102"],
] as const;

test("admits exactly the Ultra 205 and the Gamma 601", () => {
  // Act
  const boards = REFERENCE_FIRMWARE_BOARDS.map((board) => [board.model, board.revision]);

  // Assert
  expect(boards).toEqual(admitted.map((pair) => [...pair]));
});

test("finds each admitted board by its exact identity and by its revision", () => {
  // Act
  const byIdentity = REFERENCE_FIRMWARE_BOARDS.map((board) =>
    maybeReferenceFirmwareBoard(board.model, board.revision)
  );
  const byRevision = REFERENCE_FIRMWARE_BOARDS.map((board) =>
    maybeReferenceFirmwareBoardByRevision(board.revision)
  );

  // Assert
  expect(byIdentity).toEqual([...REFERENCE_FIRMWARE_BOARDS]);
  expect(byRevision).toEqual([...REFERENCE_FIRMWARE_BOARDS]);
});

test.each(refused)("refuses %s revision %s", (model, revision) => {
  // Act
  const maybeBoard = maybeReferenceFirmwareBoard(model, revision);

  // Assert
  expect(maybeBoard).toBeUndefined();
});

test("refuses a revision outside the admitted set", () => {
  // Act / Assert
  expect(maybeReferenceFirmwareBoardByRevision("204")).toBeUndefined();
});

test.each([
  ...admitted.map(([model, revision]) => [model, revision, true] as const),
  ...refused.map(([model, revision]) => [model, revision, false] as const),
])("the Controller 0.4 schema gives %s revision %s validity %p", (model, revision, valid) => {
  // Arrange
  const validate = schemaValidator().getSchema(controllerSchema.$id);
  if (!validate) throw new Error("controller schema missing");
  const fixtures = structuredClone(controllerFixtures);
  fixtures.capabilities.board = { ...fixtures.capabilities.board, model, revision };
  fixtures.capabilities.attestation.claims.board = { model, revision };

  // Act
  const result = validate(fixtures);

  // Assert
  expect(result).toBe(valid);
});

test.each([
  ...admitted.map(([model, revision]) => [model, revision, true] as const),
  ...refused.map(([model, revision]) => [model, revision, false] as const),
])("the deployment trust schema gives %s revision %s validity %p", (model, revision, valid) => {
  // Arrange
  const validate = schemaValidator().getSchema(trustSchema.$id);
  if (!validate) throw new Error("deployment trust schema missing");
  const fixtures = structuredClone(trustFixtures);
  const capability = fixtures.ultra205.capabilityInput.capability;
  capability.board = { ...capability.board, model, revision };

  // Act
  const result = validate(fixtures);

  // Assert
  expect(result).toBe(valid);
});

function schemaValidator(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(controllerSchema);
  ajv.addSchema(usbSchema);
  ajv.addSchema(trustSchema);
  return ajv;
}
