import { describe, expect, test } from "bun:test";
import type { BitaxeOnboarding, BitaxeOnboardingResult, FirmwarePackage } from "./bitaxe-onboarding";
import { bitaxeUsbOnboardingAction, GrantedBitaxePort } from "./bitaxe-usb-onboarding";
import type { WorkGateConfiguration } from "./bwg-work-gate";
import { instantClock } from "./rom-onboarding.test-support";
import type { WorkerSerialAccess, WorkerSerialPort } from "./webserial-worker-port";

const FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };

function port(connected = true, info = FILTER): WorkerSerialPort & { connected: boolean } {
  return {
    readable: null,
    writable: null,
    connected,
    getInfo: () => info,
    open: async () => undefined,
    close: async () => undefined,
  };
}

function serial(granted: WorkerSerialPort[], chosen: WorkerSerialPort) {
  const calls = { requestPort: 0 };
  const access: WorkerSerialAccess = {
    requestPort: async () => {
      calls.requestPort += 1;
      return chosen;
    },
    getPorts: async () => granted,
  };
  return { access, calls };
}

describe("GrantedBitaxePort", () => {
  test("asks the chooser in the gesture when no port is granted yet", async () => {
    // Arrange
    const chosen = port();
    const { access, calls } = serial([], chosen);
    const grant = new GrantedBitaxePort(access, FILTER, instantClock());

    // Act
    await grant.select();

    // Assert
    expect(calls.requestPort).toBe(1);
    expect(await grant.current()).toBe(chosen);
  });

  test("re-finds the grant after the chip re-enumerates on a reset", async () => {
    // Arrange
    const before = port();
    const returned = port();
    const granted: WorkerSerialPort[] = [before];
    const { access } = serial(granted, before);
    const grant = new GrantedBitaxePort(access, FILTER, instantClock());
    await grant.select();
    before.connected = false;
    granted.splice(0, 1, before, returned);

    // Act
    const current = await grant.current();

    // Assert
    expect(current).toBe(returned);
  });

  test("hands onboarding's reconnects only the grant, never the chooser", async () => {
    // Arrange
    const granted = port();
    const { access, calls } = serial([granted], granted);
    const grant = new GrantedBitaxePort(access, FILTER, instantClock());
    await grant.select();

    // Act
    const reconnect = grant.access();

    // Assert
    expect(await reconnect.getPorts?.()).toEqual([granted]);
    await expect(reconnect.requestPort({ filters: [FILTER] })).rejects.toThrow("reuse the granted port");
    expect(calls.requestPort).toBe(0);
  });

  test("refuses to pick between several attached boards after a reset", async () => {
    // Arrange
    const before = port();
    const granted: WorkerSerialPort[] = [before];
    const { access } = serial(granted, before);
    const grant = new GrantedBitaxePort(access, FILTER, instantClock());
    await grant.select();
    before.connected = false;
    granted.push(port(), port());

    // Act
    const current = grant.current();

    // Assert
    await expect(current).rejects.toThrow("several Bitaxe boards");
  });
});

describe("bitaxeUsbOnboardingAction", () => {
  const ready = { status: "ready" } as BitaxeOnboardingResult;

  function fakeOnboarding(result: BitaxeOnboardingResult) {
    const calls: string[] = [];
    const onboarding = {
      connect: async () => {
        calls.push("connect");
        return {} as Awaited<ReturnType<BitaxeOnboarding["connect"]>>;
      },
      install: async (_package: FirmwarePackage, options?: { maybeBackupPassphrase?: string }) => {
        calls.push(`install:${options?.maybeBackupPassphrase ?? "no-backup"}`);
        return result;
      },
      rollbackState: () => "available" as const,
      complete: () => {
        calls.push("complete");
      },
      rollBack: async () => {
        calls.push("rollBack");
        return { ...result, status: "rolled_back" as const };
      },
    } satisfies BitaxeOnboarding;
    const create = () => ({
      onboarding,
      release: async () => {
        calls.push("release");
      },
    });
    return { create, calls };
  }

  const prompts = (decision: "complete" | "roll_back") => ({
    loadFirmwarePackage: async () => ({}) as FirmwarePackage,
    maybeBackupPassphrase: async () => "passphrase",
    decide: async () => decision,
  });

  test("fits the work gate's Connect Bitaxe over USB seam", () => {
    // Arrange
    const { create } = fakeOnboarding(ready);

    // Act
    const action: WorkGateConfiguration["maybeOnboardBitaxe"] = bitaxeUsbOnboardingAction(create, prompts("complete"));

    // Assert
    expect(typeof action).toBe("function");
  });

  test("connects, installs with the backup, completes and releases the port", async () => {
    // Arrange
    const { create, calls } = fakeOnboarding(ready);

    // Act
    await bitaxeUsbOnboardingAction(create, prompts("complete"))();

    // Assert
    expect(calls).toEqual(["connect", "install:passphrase", "complete", "release"]);
  });

  test("rolls back at the user's request and reports that the board is not ready", async () => {
    // Arrange
    const { create, calls } = fakeOnboarding(ready);

    // Act
    const running = bitaxeUsbOnboardingAction(create, prompts("roll_back"))();

    // Assert
    await expect(running).rejects.toThrow("rolled back at the user's request");
    expect(calls).toEqual(["connect", "install:passphrase", "rollBack", "release"]);
  });

  test("reports an install that rolled itself back, and still releases the port", async () => {
    // Arrange
    const { create, calls } = fakeOnboarding({ status: "rolled_back" } as BitaxeOnboardingResult);

    // Act
    const running = bitaxeUsbOnboardingAction(create, prompts("complete"))();

    // Assert
    await expect(running).rejects.toThrow("runs its previous firmware");
    expect(calls.at(-1)).toBe("release");
  });
});
