import { describe, expect, test } from "bun:test";

import {
  createHeadlessClient,
  prepareClaimantIdentity,
  restoreClaimantIdentity,
  type HeadlessEvent,
} from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";

describe("pairwise Claimant key", () => {
  test("prepares only public Claimant material before challenge issuance", async () => {
    // Arrange
    const identity = await prepareClaimantIdentity({ maybeClock: () => 1_000 });

    // Act
    const claimantKey = JSON.parse(identity.claimantKey());

    // Assert
    expect(claimantKey).toEqual({
      crv: "P-256",
      kty: "EC",
      x: identity.claimantPublicJwk().x,
      y: identity.claimantPublicJwk().y,
    });
    expect("sign" in identity).toBe(false);
  });

  test("generates a fresh non-extractable key for each client", async () => {
    // Arrange
    const firstHarness = transportHarness();
    const secondHarness = transportHarness();

    // Act
    const first = await createHeadlessClient(await headlessInput(firstHarness.transport));
    const second = await createHeadlessClient(await headlessInput(secondHarness.transport));
    const proof = await first.signClaimantProof(new TextEncoder().encode("proof"));

    // Assert
    expect(first.claimantPublicJwk().d).toBeUndefined();
    expect(first.claimantPublicJwk()).not.toEqual(second.claimantPublicJwk());
    expect(proof.byteLength).toBeGreaterThan(0);
  });

  test("fails signing closed at the challenge artifact expiry", async () => {
    // Arrange
    let now = 1_999;
    const harness = transportHarness();
    const client = await createHeadlessClient(
      await headlessInput(harness.transport, { maybeClock: () => now }),
    );
    const payload = new Uint8Array([1]);

    // Act
    const beforeExpiry = client.signClaimantProof(payload);
    now = 2_000;
    await beforeExpiry;
    const atExpiry = client.signClaimantProof(payload);

    // Assert
    await expect(atExpiry).rejects.toThrow("Claimant key is no longer retained");
  });

  test("extends retention only from an Authority artifact event", async () => {
    // Arrange
    let now = 1_999;
    const harness = transportHarness();
    const client = await createHeadlessClient(
      await headlessInput(harness.transport, { maybeClock: () => now }),
    );

    // Act
    await harness.emitAuthority({ type: "artifact_expiry", expiresAtUnixSeconds: 2_100 });
    now = 2_050;
    const retainedProof = await client.signClaimantProof(new Uint8Array([1]));

    // Assert
    expect(retainedProof.byteLength).toBeGreaterThan(0);
    expect("retainClaimantKeyThrough" in client).toBe(false);
  });

  test("rejects a challenge bound to a different prepared key", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const otherIdentity = await prepareClaimantIdentity({ maybeClock: () => 1_000 });
    input.claimantIdentity = otherIdentity;

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Work Challenge is bound to a different Claimant key");
  });

  test("does not reuse one pairwise key for a second challenge", async () => {
    // Arrange
    const identity = await prepareClaimantIdentity({ maybeClock: () => 1_000 });
    const firstHarness = transportHarness();
    await createHeadlessClient(
      await headlessInput(firstHarness.transport, { maybeIdentity: identity }),
    );
    const secondHarness = transportHarness();
    const secondInput = await headlessInput(secondHarness.transport, { maybeIdentity: identity });
    secondInput.challenge.challengeId = "challenge_headless_02";

    // Act
    const secondCreation = createHeadlessClient(secondInput);

    // Assert
    await expect(secondCreation).rejects.toThrow(
      "Claimant key is already bound to another Work Challenge",
    );
  });

  test("restores non-extractable key access and paused work after tab closure", async () => {
    // Arrange
    const clock = () => 1_000;
    const identity = await prepareClaimantIdentity({ maybeClock: clock });
    const firstHarness = transportHarness();
    const firstClient = await createHeadlessClient(
      await headlessInput(firstHarness.transport, { maybeClock: clock, maybeIdentity: identity }),
    );
    await firstClient.grantConsent();
    await firstClient.start();
    firstClient.close();

    // Act
    const restoredIdentity = await restoreClaimantIdentity(identity.keyId(), { maybeClock: clock });
    const restoredHarness = transportHarness();
    const restoredClient = await createHeadlessClient(
      await headlessInput(restoredHarness.transport, {
        maybeClock: clock,
        maybeIdentity: restoredIdentity,
        maybeRestoration: { challengeState: "active" },
      }),
    );
    await restoredClient.resume();
    const proof = await restoredClient.signClaimantProof(new Uint8Array([1]));

    // Assert
    expect(restoredHarness.calls).toEqual(["resume"]);
    expect(restoredClient.claimantPublicJwk().d).toBeUndefined();
    expect(proof.byteLength).toBeGreaterThan(0);
  });

  test("restores a current pass-issued snapshot without replaying intermediate states", async () => {
    // Arrange
    const clock = () => 1_000;
    const identity = await prepareClaimantIdentity({ maybeClock: clock });
    const firstHarness = transportHarness();
    const firstClient = await createHeadlessClient(
      await headlessInput(firstHarness.transport, { maybeClock: clock, maybeIdentity: identity }),
    );
    await firstClient.grantConsent();
    await firstClient.start();
    firstClient.close();
    const restoredIdentity = await restoreClaimantIdentity(identity.keyId(), { maybeClock: clock });
    const restoredHarness = transportHarness();

    // Act
    const restoredClient = await createHeadlessClient(
      await headlessInput(restoredHarness.transport, {
        maybeClock: clock,
        maybeIdentity: restoredIdentity,
        maybeRestoration: { challengeState: "pass_issued" },
      }),
    );
    const events: HeadlessEvent[] = [];
    restoredClient.subscribe((event) => events.push(event));
    const proof = await restoredClient.signClaimantProof(new Uint8Array([1]));

    // Assert
    expect(events).toEqual([
      { type: "lifecycle", challengeState: "pass_issued", controlState: "completed" },
    ]);
    expect(proof.byteLength).toBeGreaterThan(0);
  });

  test("deletes an expired persisted key instead of restoring it", async () => {
    // Arrange
    let now = 1_000;
    const identity = await prepareClaimantIdentity({ maybeClock: () => now });
    now = 1_300;

    // Act
    const restoration = restoreClaimantIdentity(identity.keyId(), { maybeClock: () => now });

    // Assert
    await expect(restoration).rejects.toThrow("Claimant key is no longer retained");
  });

  test("cannot revive an expired preissuance key by binding a later challenge", async () => {
    // Arrange
    let now = 1_000;
    const identity = await prepareClaimantIdentity({ maybeClock: () => now });
    const harness = transportHarness();
    const input = await headlessInput(harness.transport, {
      maybeClock: () => now,
      maybeIdentity: identity,
    });
    now = 1_300;

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Claimant key is no longer retained");
  });

  test("cannot revive an expired challenge key with a later artifact event", async () => {
    // Arrange
    let now = 1_000;
    const harness = transportHarness();
    await createHeadlessClient(
      await headlessInput(harness.transport, { maybeClock: () => now }),
    );
    now = 2_000;

    // Act
    const extension = harness.emitAuthority({
      type: "artifact_expiry",
      expiresAtUnixSeconds: 2_100,
    });

    // Assert
    await expect(extension).rejects.toThrow("Claimant key is no longer retained");
  });

  test("does not overwrite durable consent with a different disclosure", async () => {
    // Arrange
    const identity = await prepareClaimantIdentity({ maybeClock: () => 1_000 });
    const firstHarness = transportHarness();
    const firstClient = await createHeadlessClient(
      await headlessInput(firstHarness.transport, { maybeIdentity: identity }),
    );
    const secondHarness = transportHarness();
    const secondInput = await headlessInput(secondHarness.transport, {
      maybeIdentity: identity,
    });
    secondInput.selection = {
      poolOfferId: "pool_offer_hydra_solo_v1",
      payoutDestinationType: "approved_beneficiary",
      beneficiaryId: "open_source_bitcoin_research",
    };
    const secondClient = await createHeadlessClient(secondInput);
    await firstClient.grantConsent();

    // Act
    const conflictingConsent = secondClient.grantConsent();

    // Assert
    await expect(conflictingConsent).rejects.toThrow(
      "Work Consent is already bound to a different disclosure",
    );
  });
});
