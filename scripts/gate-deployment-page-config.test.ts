import { expect, test } from "bun:test";

import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { appElfSha256, buildPageConfig } from "./gate-deployment-page-config";

const ELF_DIGEST = "a".repeat(64);
const SUMS = `${"b".repeat(64)}  bootloader.bin\n${ELF_DIGEST}  esp-miner.elf\n${"c".repeat(64)}  esp-miner.bin\n`;
const PUBLIC_KEYS = [{ kid: "gate-pass-test", kty: "OKP", crv: "Ed25519", x: "x", alg: "Ed25519", use: "sig", key_ops: ["verify"] }];

function input(overrides: Partial<Parameters<typeof buildPageConfig>[0]> = {}) {
  return {
    origin: "https://gate.example.test",
    publicKeys: PUBLIC_KEYS,
    ownerTrust: trust,
    imageCommit: "1".repeat(40),
    sha256Sums: SUMS,
    gateCommit: "2".repeat(40),
    ...overrides,
  };
}

test("binds the page to the origin's Gate Pass keys and the image's digests", () => {
  // Act
  const config = buildPageConfig(input());

  // Assert
  expect(config.authorityTrust).toEqual({ issuer: "https://gate.example.test", trustedKeys: PUBLIC_KEYS });
  expect(config.worker.expectedFirmwareSourceCommit).toBe("1".repeat(40));
  expect(config.worker.expectedAppElfSha256).toBe(ELF_DIGEST);
  expect(config.worker.trustedUpdateKeys).toEqual(trust.updateAuthority.keys);
  expect(config.worker.deviceFilter).toEqual({ usbVendorId: 0x303a, usbProductId: 0x1001 });
});

test("sets both work ceilings at or above 2^44", () => {
  // Act
  const config = buildPageConfig(input());

  // Assert
  expect(BigInt(config.claimantWorkCeiling) >= 2n ** 44n).toBe(true);
  expect(BigInt(config.clientSafetyCeiling) >= 2n ** 44n).toBe(true);
});

test("refuses SHA256SUMS without exactly one ELF", () => {
  // Arrange
  const twoElves = `${SUMS}${"d".repeat(64)}  other.elf\n`;

  // Act
  const none = () => appElfSha256(`${"b".repeat(64)}  bootloader.bin\n`);
  const two = () => appElfSha256(twoElves);

  // Assert
  expect(none).toThrow("exactly one .elf");
  expect(two).toThrow("exactly one .elf");
});

test("refuses a non-https origin and a malformed image commit", () => {
  // Act
  const plainOrigin = () => buildPageConfig(input({ origin: "http://gate.example.test" }));
  const shortCommit = () => buildPageConfig(input({ imageCommit: "247d2cd" }));

  // Assert
  expect(plainOrigin).toThrow("https");
  expect(shortCommit).toThrow("COMMIT");
});

test("offers both boards, each named by the board its signed capability reports", () => {
  // Act
  const config = buildPageConfig(input());

  // Assert
  expect(config.workers.map((worker) => worker.maybeBoard)).toEqual([
    { model: "bitaxe-gamma", revision: "601" },
    { model: "bitaxe-ultra", revision: "205" },
  ]);
});

test("offers no standard Stratum V1 Worker unless the deployment names one", () => {
  // Act
  const config = buildPageConfig(input());

  // Assert
  expect("maybeStandardWorker" in config).toBe(false);
});

test("offers the standard Stratum V1 Worker the deployment names", () => {
  // Act
  const config = buildPageConfig(input({ maybeStandardWorker: { displayName: "Your Stratum V1 Worker", hashrateHs: "1000000000000" } }));

  // Assert
  expect(config.maybeStandardWorker).toEqual({
    workerId: "standard-stratum-v1",
    displayName: "Your Stratum V1 Worker",
    hashrateHs: "1000000000000",
  });
});

test("refuses a standard Worker hashrate that isn't a whole number", () => {
  // Act and assert
  expect(() => buildPageConfig(input({ maybeStandardWorker: { displayName: "Worker", hashrateHs: "1e12" } }))).toThrow(
    "the standard Worker's hashrate must be a whole number of H/s",
  );
});
