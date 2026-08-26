import { describe, expect, test } from "bun:test";

import {
  ConsentRequiredError,
  createHeadlessClient,
  type HeadlessEvent,
} from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";

describe("headless lifecycle controls", () => {
  test("Start maps consented issued work to active running", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();

    // Act
    await client.start();

    // Assert
    expect(harness.calls).toEqual(["start"]);
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "active",
      controlState: "running",
    });
  });

  test("Pause maps active running work to active paused", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();
    await client.start();

    // Act
    await client.pause();

    // Assert
    expect(harness.calls.at(-1)).toBe("pause");
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "active",
      controlState: "paused",
    });
  });

  test("resume maps active paused work to active running", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();
    await client.start();
    await client.pause();

    // Act
    await client.resume();

    // Assert
    expect(harness.calls.at(-1)).toBe("resume");
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "active",
      controlState: "running",
    });
  });

  test("Cancel maps active work to terminal cancelled", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();
    await client.start();

    // Act
    await client.cancel();

    // Assert
    expect(harness.calls.at(-1)).toBe("cancel");
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "cancelled",
      controlState: "cancelled",
    });
    await expect(client.resume()).rejects.toThrow("lifecycle transition is forbidden");
  });
});

describe("Authority observations", () => {
  test("maps an Authority active snapshot atomically after consent", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();

    // Act
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "active" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "active",
      controlState: "running",
    });
  });

  test("rejects an active snapshot without recorded Work Consent", async () => {
    // Arrange
    const harness = transportHarness();
    await createHeadlessClient(await headlessInput(harness.transport));

    // Act
    const activation = harness.emitAuthority({ type: "challenge_lifecycle", state: "active" });

    // Assert
    await expect(activation).rejects.toThrow(
      "active work requires restored or recorded Work Consent",
    );
  });

  test("derives Verified Progress only from Authority events", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));

    // Act
    await harness.emitAuthority({ type: "verified_progress", acceptedHashes: "4295032833" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "verified_progress",
      verifiedProgress: "4295032833",
      workRequirement: "17592186044416",
      satisfied: false,
    });
    expect("updateVerifiedProgress" in client).toBe(false);
  });

  test("keeps Activity Estimate separate from Verified Progress", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));

    // Act
    client.reportActivityEstimate({ status: "active", hashrateHs: "400000000000" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "activity_estimate",
      status: "active",
      hashrateHs: "400000000000",
    });
    expect(events.some((event) => event.type === "verified_progress")).toBe(false);
  });

  test("rejects a non-canonical Activity Estimate", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));

    // Act
    const report = () =>
      client.reportActivityEstimate({ status: "active", hashrateHs: "0400000000000" });

    // Assert
    expect(report).toThrow("Activity Estimate hashrate must be a canonical positive integer");
  });

  test("maps satisfied work to a non-resumable completed state", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();
    await client.start();

    // Act
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "satisfied",
      controlState: "completed",
    });
    await expect(client.resume()).rejects.toThrow("lifecycle transition is forbidden");
  });

  test("accepts a current pass-issued snapshot after an offline interval", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();
    await client.start();

    // Act
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "pass_issued" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "pass_issued",
      controlState: "completed",
    });
  });

  test("rejects public lifecycle regression after completion", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    await client.grantConsent();
    await client.start();
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

    // Act
    const regression = harness.emitAuthority({ type: "challenge_lifecycle", state: "active" });

    // Assert
    await expect(regression).rejects.toThrow("lifecycle transition is forbidden");
  });

  test("maps Authority expiry to a non-resumable expired state", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();

    // Act
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "expired" });

    // Assert
    expect(events.at(-1)).toEqual({
      type: "lifecycle",
      challengeState: "expired",
      controlState: "expired",
    });
    await expect(client.start()).rejects.toThrow("lifecycle transition is forbidden");
  });

  test("Authority expiry invalidates consent that is still being persisted", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));

    // Act
    const consent = client.grantConsent();
    await harness.emitAuthority({ type: "challenge_lifecycle", state: "expired" });

    // Assert
    await expect(consent).rejects.toThrow("trusted consent was aborted");
    await expect(client.start()).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  test("emits metadata-only events", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));
    const events: HeadlessEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.grantConsent();

    // Act
    await client.start();
    await harness.emitAuthority({ type: "verified_progress", acceptedHashes: "1" });
    client.reportActivityEstimate({ status: "unavailable" });

    // Assert
    expect(JSON.stringify(events)).not.toMatch(
      /private|credential|action_reference|actionReference|payoutDestination|worker_local/,
    );
  });
});
