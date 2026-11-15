import { describe, expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { createBitaxeOnboarding, type FirmwarePackage, type UpdateAuthorityJwk } from "./bitaxe-onboarding";
import {
  createOnboardingSitting,
  firmwarePackageFromFiles,
  parseSittingConfiguration,
  type SittingConfiguration,
} from "./bitaxe-onboarding-sitting";
import { firmwarePackage, settings, snapshot } from "./bitaxe-onboarding-test-fixtures";
import { SimulatedBitaxeConnector } from "./simulated-bitaxe-onboarding";

const DIGEST = "3c83711e28525fd6217b2645fa72a3043ecbb2952d4de81bc0a8d0b0342d733d";

function configurationText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ board: "601", expectedBaseMacSha256: DIGEST, trust, ...overrides });
}

/** A sitting over the simulated stock Gamma, whose release is counted. */
async function simulatedSitting() {
  const connector = new SimulatedBitaxeConnector(snapshot(), settings);
  const signed = await firmwarePackage();
  const released = { count: 0 };
  const sitting = createOnboardingSitting({
    configuration: parseSittingConfiguration(configurationText()),
    firmwarePackage: signed.package,
    maybeCreate: () => ({
      onboarding: createBitaxeOnboarding({
        requestDevice: () => connector.requestDevice(),
        trustedUpdateKeys: [signed.publicKey as UpdateAuthorityJwk],
        downloadMigrationBackup: async () => undefined,
      }),
      release: async () => {
        released.count += 1;
      },
    }),
  });
  return { sitting, device: connector.device(), released };
}

describe("parseSittingConfiguration", () => {
  test("reads the board, the expected digest and the owner's trust", () => {
    // Arrange
    const text = configurationText();

    // Act
    const configuration: SittingConfiguration = parseSittingConfiguration(text);

    // Assert
    expect(configuration.board).toBe("601");
    expect(configuration.trust.updateAuthority.keys.length).toBeGreaterThan(0);
  });

  test("refuses a board that isn't one of the owner's", () => {
    expect(() => parseSittingConfiguration(configurationText({ board: "999" }))).toThrow("board");
  });

  test("refuses a digest that isn't 64 lower-case hex digits", () => {
    expect(() => parseSittingConfiguration(configurationText({ expectedBaseMacSha256: "abc" }))).toThrow("digest");
  });

  test("refuses trust that isn't the role-separated deployment trust", () => {
    expect(() => parseSittingConfiguration(configurationText({ trust: {} }))).toThrow();
  });
});

describe("firmwarePackageFromFiles", () => {
  test("joins the signed manifest file with the image, bootloader and table", async () => {
    // Arrange
    const { package: signed } = await firmwarePackage();
    const signedManifest = JSON.stringify({ manifest: signed.manifest, signature: signed.signature });

    // Act
    const joined: FirmwarePackage = firmwarePackageFromFiles({
      signedManifest,
      image: signed.image,
      bootloader: signed.bootloader,
      partitionTable: signed.partitionTable,
    });

    // Assert
    expect(joined).toEqual(signed);
  });

  test("refuses a manifest file without a manifest and a signature", () => {
    // Arrange
    const empty = new Uint8Array();

    // Act
    const join = () =>
      firmwarePackageFromFiles({ signedManifest: "{}", image: empty, bootloader: empty, partitionTable: empty });

    // Assert
    expect(join).toThrow("signed manifest");
  });
});

describe("createOnboardingSitting", () => {
  test("starts configured, touching no device", async () => {
    // Arrange
    const { sitting, device } = await simulatedSitting();

    // Act
    const state = sitting.state();

    // Assert
    expect(state.status).toBe("configured");
    expect(device.flashCount()).toBe(0);
  });

  test("shows what Connect found and waits for the owner", async () => {
    // Arrange
    const { sitting } = await simulatedSitting();

    // Act
    await sitting.connect();

    // Assert
    expect(sitting.state()).toMatchObject({
      status: "inspected",
      inspection: { action: "firmware_required", board: { model: "bitaxe-gamma", revision: "204" }, migrationBackup: "recommended" },
    });
  });

  test("Stop before install writes nothing and releases the port", async () => {
    // Arrange
    const { sitting, device, released } = await simulatedSitting();
    await sitting.connect();

    // Act
    await sitting.stopBeforeInstall();

    // Assert
    expect({ status: sitting.state().status, flashes: device.flashCount(), released: released.count }).toEqual({
      status: "stopped",
      flashes: 0,
      released: 1,
    });
  });

  test("Install then Keep completes onboarding", async () => {
    // Arrange
    const { sitting, released } = await simulatedSitting();
    await sitting.connect();
    await sitting.install();

    // Act
    await sitting.keep();

    // Assert
    expect(sitting.state()).toMatchObject({ status: "completed", result: { status: "ready", firmwareVersion: "2.0.0" } });
    expect(released.count).toBe(1);
  });

  test("Install then Roll back restores the previous firmware", async () => {
    // Arrange
    const { sitting } = await simulatedSitting();
    await sitting.connect();
    await sitting.install();

    // Act
    await sitting.rollBack();

    // Assert
    expect(sitting.state()).toMatchObject({ status: "rolled_back", result: { status: "rolled_back", rollback: "confirmed" } });
  });

  test("reports a failure with its message, and still releases the port", async () => {
    // Arrange
    const released = { count: 0 };
    const other = await firmwarePackage();
    const untrusted = createOnboardingSitting({
      configuration: parseSittingConfiguration(configurationText()),
      firmwarePackage: other.package,
      maybeCreate: () => ({
        onboarding: createBitaxeOnboarding({
          requestDevice: () => new SimulatedBitaxeConnector(snapshot(), settings).requestDevice(),
          trustedUpdateKeys: [],
        }),
        release: async () => {
          released.count += 1;
        },
      }),
    });
    await untrusted.connect();

    // Act
    await untrusted.install();

    // Assert
    expect(untrusted.state().status).toBe("failed");
    expect(untrusted.state().error).toBeString();
    expect(released.count).toBe(1);
  });

  test("carries no settings value, passphrase or digest in its state", async () => {
    // Arrange
    const { sitting } = await simulatedSitting();
    await sitting.connect();
    await sitting.install({ maybeBackupPassphrase: "owner-passphrase" });
    await sitting.keep();

    // Act
    const text = JSON.stringify(sitting.state());

    // Assert
    for (const secret of ["secret-network", "secret-password", "pool.example", "owner-passphrase", DIGEST]) {
      expect(text).not.toContain(secret);
    }
  });
});
