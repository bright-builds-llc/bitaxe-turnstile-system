export * from "./headless-client.types";
export {
  PreparedClaimantIdentity,
  prepareClaimantIdentity,
  restoreClaimantIdentity,
} from "./headless-key";
export { requestTrustedConsentWithPopup } from "./trusted-consent-popup";
export { verifyTrustedConsentReceipt } from "./trusted-consent";
export { verifyPoolOfferSet } from "./headless-pool-offer";
import {
  ConsentRequiredError,
  TrustedConsentRequiredError,
  WorkCeilingExceededError,
  type ChallengeLifecycleState,
  type HeadlessClient,
  type HeadlessClientInput,
  type HeadlessEvent,
  type LifecycleEvent,
  type PoolSelectionInput,
  type WorkConsentDisclosure,
  type WorkConsentReceipt,
  type TrustedConsentRequest,
} from "./headless-client.types";
import { claimantIdentityAccess } from "./headless-key";
import { selectPoolOffer, verifyPoolOfferSet } from "./headless-pool-offer";
import { prepareTrustedConsent } from "./headless-trusted-consent";
import {
  canonicalJson,
  canonicalNonNegativeBigInt,
  canonicalSafePositiveBigInt,
  estimateWork,
  sha256Base64Url,
} from "./headless-values";
import { verifyTrustedConsentReceipt } from "./trusted-consent";
import {
  discoverWorker,
  renewWorkerController,
  restoreWorkerController,
  restorationReason,
  shutdownWorkerController,
  startWorkerController,
  stopWorkerController,
  validatedWorkerStatus,
} from "./headless-worker-control";

export async function createHeadlessClient(input: HeadlessClientInput): Promise<HeadlessClient> {
  const snapshot = snapshotInput(input);
  const maybeWorkerCapabilities = snapshot.maybeWorkerController
    ? await discoverWorker(snapshot.maybeWorkerController)
    : undefined;
  const expectedHashes = canonicalSafePositiveBigInt(
    snapshot.challenge.expectedHashes,
    "expected hashes",
  );
  const claimantCeiling = canonicalSafePositiveBigInt(
    snapshot.claimantWorkCeiling,
    "claimant ceiling",
  );
  const safetyCeiling = canonicalSafePositiveBigInt(
    snapshot.clientSafetyCeiling,
    "client safety ceiling",
  );
  const identity = input.claimantIdentity;
  if (!claimantKeyMatches(snapshot.challenge.claimantKey, identity.claimantKey())) {
    throw new Error("Work Challenge is bound to a different Claimant key");
  }
  const identityAccess = identity[claimantIdentityAccess]();
  await identityAccess.bindToChallenge(
    snapshot.challenge.challengeId,
    snapshot.challenge.expiresAtUnixSeconds,
  );
  const verifiedOfferSet = await verifyPoolOfferSet(
    snapshot.signedPoolOfferSet,
    snapshot.challenge,
    snapshot.authorityTrust,
  );
  const selectedOffer = await selectPoolOffer(verifiedOfferSet.offers, snapshot.selection);
  const trustedConsent = await prepareTrustedConsent({
    challenge: snapshot.challenge,
    authorityTrust: snapshot.authorityTrust,
    poolOfferSetSignature: snapshot.signedPoolOfferSet.signature,
    trustedConfirmationRequired: verifiedOfferSet.trustedConfirmationRequired,
    ...(snapshot.maybeNowUnixSeconds
      ? { maybeNowUnixSeconds: snapshot.maybeNowUnixSeconds }
      : {}),
  });
  const maybeTrustedConsentRequirement = trustedConsent.maybeRequirement;
  const estimates = estimateWork(expectedHashes, snapshot.workers);
  const disclosureSnapshot: WorkConsentDisclosure = {
    challengeId: snapshot.challenge.challengeId,
    actionPolicy: snapshot.challenge.actionPolicy,
    expectedHashes: expectedHashes.toString(),
    equivalentBinaryZeroWork: Math.log2(Number(expectedHashes)),
    ...estimates,
    poolOfferSetSignature: snapshot.signedPoolOfferSet.signature,
    authorityIssuer: snapshot.authorityTrust.issuer,
    authorityKeyId: verifiedOfferSet.authorityKeyId,
    poolOffer: selectedOffer,
    rewardPolicy: selectedOffer.rewardPolicy,
    payoutDestinationType: snapshot.selection.payoutDestinationType,
    payoutDestination: payoutDestination(snapshot.selection),
    workers: snapshot.workers,
    cancellationBehavior: "pause_preserves_progress_cancel_is_terminal",
    claimantWorkCeiling: claimantCeiling.toString(),
    clientSafetyCeiling: safetyCeiling.toString(),
    ...(maybeTrustedConsentRequirement ? { maybeTrustedConsentRequirement } : {}),
  };
  const disclosureDigest = await sha256Base64Url(canonicalJson(disclosureSnapshot));
  const maybeTrustedConsentRequest = trustedConsent.maybeRequest;
  const nowUnixSeconds = trustedConsent.nowUnixSeconds;
  let maybeConsentReceipt = await restoredConsent(
    input,
    identityAccess.maybeConsentFor(snapshot.challenge.challengeId),
    disclosureDigest,
    disclosureSnapshot,
    maybeTrustedConsentRequest,
    nowUnixSeconds(),
  );
  let consentGeneration = 0;
  let lifecycle = restoredLifecycle(input);
  const listeners = new Set<(event: HeadlessEvent) => void>();
  const emit = (event: HeadlessEvent) => {
    for (const listener of listeners) listener(structuredClone(event));
  };
  const setLifecycle = (next: LifecycleEvent) => {
    lifecycle = next;
    emit(next);
  };
  const pauseAfterControllerDisconnect = async () => {
    if (lifecycle.challengeState !== "active" || lifecycle.controlState !== "running") return;
    await snapshot.transport.pause();
    if (lifecycle.challengeState === "active" && lifecycle.controlState === "running") {
      setLifecycle({ type: "lifecycle", challengeState: "active", controlState: "paused" });
    }
  };
  const unsubscribeWorkerDisconnect = snapshot.maybeWorkerController?.subscribeDisconnect?.(
    async () => pauseAfterControllerDisconnect(),
  );
  const unsubscribeAuthority = snapshot.transport.subscribeAuthorityEvents(async (event) => {
    if (event.type === "artifact_expiry") {
      await identityAccess.retainThrough(event.expiresAtUnixSeconds);
      return;
    }
    if (event.type === "verified_progress") {
      const progress = canonicalNonNegativeBigInt(event.acceptedHashes, "Verified Progress");
      emit({
        type: "verified_progress",
        verifiedProgress: progress.toString(),
        workRequirement: expectedHashes.toString(),
        satisfied: progress >= expectedHashes,
      });
      return;
    }
    const nextLifecycle = authorityLifecycleTransition(lifecycle, event.state);
    const maybeRestorationReason = restorationReason(event.state);
    if (snapshot.maybeWorkerController && maybeRestorationReason) {
      await restoreWorkerController(snapshot.maybeWorkerController, maybeRestorationReason);
    }
    if (
      lifecycle.challengeState === "issued" &&
      lifecycle.controlState === "awaiting_consent" &&
      (nextLifecycle.challengeState !== "issued" ||
        nextLifecycle.controlState !== "awaiting_consent")
    ) {
      consentGeneration += 1;
    }
    setLifecycle(nextLifecycle);
  });

  return {
    claimantPublicJwk: () => identity.claimantPublicJwk(),
    signClaimantProof: (payload) => identityAccess.sign(payload),
    disclosure: () => structuredClone(disclosureSnapshot),
    trustedConsentRequest: () => maybeTrustedConsentRequest
      ? structuredClone(maybeTrustedConsentRequest)
      : undefined,
    async grantConsent(maybeTrustedConsentReceipt, maybeSignal) {
      const generation = consentGeneration;
      throwIfConsentAborted(maybeSignal, generation, consentGeneration);
      if (
        lifecycle.challengeState !== "issued" ||
        lifecycle.controlState !== "awaiting_consent"
      ) {
        throw new Error("lifecycle transition is forbidden");
      }
      if (expectedHashes > claimantCeiling || expectedHashes > safetyCeiling) {
        throw new WorkCeilingExceededError();
      }
      if (maybeTrustedConsentRequest && !maybeTrustedConsentReceipt) {
        throw new TrustedConsentRequiredError();
      }
      if (maybeTrustedConsentRequest && maybeTrustedConsentReceipt) {
        await verifyTrustedConsentReceipt(
          maybeTrustedConsentReceipt,
          maybeTrustedConsentRequest,
          snapshot.authorityTrust,
          nowUnixSeconds(),
        );
      }
      throwIfConsentAborted(maybeSignal, generation, consentGeneration);
      const consentReceipt = {
        disclosureDigestSha256: disclosureDigest,
        poolOfferSetSignature: disclosureSnapshot.poolOfferSetSignature,
        ...(maybeTrustedConsentReceipt ? { maybeTrustedConsentReceipt } : {}),
      };
      await identityAccess.recordConsent(snapshot.challenge.challengeId, consentReceipt);
      if (maybeSignal?.aborted || generation !== consentGeneration) {
        await identityAccess.clearConsent(snapshot.challenge.challengeId);
        throw new Error("trusted consent was aborted");
      }
      maybeConsentReceipt = consentReceipt;
      setLifecycle({ type: "lifecycle", challengeState: "issued", controlState: "ready" });
      return structuredClone(maybeConsentReceipt);
    },
    async start() {
      if (!maybeConsentReceipt) throw new ConsentRequiredError();
      if (lifecycle.challengeState !== "issued" || lifecycle.controlState !== "ready") {
        throw new Error("lifecycle transition is forbidden");
      }
      const maybeAuthorizationContext = snapshot.maybeWorkerLeaseAuthorizationContext
        ? await snapshot.maybeWorkerLeaseAuthorizationContext
            .prepareWorkerLeaseAuthorizationContext("start")
        : undefined;
      const maybeGrant = await snapshot.transport.start(
        maybeConsentReceipt.maybeTrustedConsentReceipt,
        maybeAuthorizationContext,
      );
      await startWorkerController(
        snapshot.maybeWorkerController,
        maybeGrant,
        snapshot.challenge.challengeId,
        snapshot.transport,
      );
      if (lifecycle.challengeState === "issued") {
        setLifecycle({ type: "lifecycle", challengeState: "active", controlState: "running" });
      }
    },
    async pause() {
      if (lifecycle.challengeState !== "active" || lifecycle.controlState !== "running") {
        throw new Error("lifecycle transition is forbidden");
      }
      await stopWorkerController(snapshot.maybeWorkerController, "pause", snapshot.transport);
      if (lifecycle.challengeState === "active" && lifecycle.controlState === "running") {
        setLifecycle({ type: "lifecycle", challengeState: "active", controlState: "paused" });
      }
    },
    async resume() {
      if (lifecycle.challengeState !== "active" || lifecycle.controlState !== "paused") {
        throw new Error("lifecycle transition is forbidden");
      }
      const maybeAuthorizationContext = snapshot.maybeWorkerLeaseAuthorizationContext
        ? await snapshot.maybeWorkerLeaseAuthorizationContext
            .prepareWorkerLeaseAuthorizationContext("start")
        : undefined;
      const maybeGrant = await snapshot.transport.resume(maybeAuthorizationContext);
      await startWorkerController(
        snapshot.maybeWorkerController,
        maybeGrant,
        snapshot.challenge.challengeId,
        snapshot.transport,
      );
      if (lifecycle.challengeState === "active" && lifecycle.controlState === "paused") {
        setLifecycle({ type: "lifecycle", challengeState: "active", controlState: "running" });
      }
    },
    async cancel() {
      if (lifecycle.challengeState !== "issued" && lifecycle.challengeState !== "active") {
        throw new Error("lifecycle transition is forbidden");
      }
      consentGeneration += 1;
      await stopWorkerController(snapshot.maybeWorkerController, "cancel", snapshot.transport);
      await identityAccess.clearConsent(snapshot.challenge.challengeId);
      if (lifecycle.challengeState === "issued" || lifecycle.challengeState === "active") {
        setLifecycle({ type: "lifecycle", challengeState: "cancelled", controlState: "cancelled" });
      }
    },
    maybeWorkerCapabilities() {
      return maybeWorkerCapabilities ? structuredClone(maybeWorkerCapabilities) : undefined;
    },
    async maybeWorkerStatus() {
      const maybeController = snapshot.maybeWorkerController;
      return maybeController
        ? structuredClone(validatedWorkerStatus(await maybeController.status()))
        : undefined;
    },
    async renewWorkerLease() {
      if (lifecycle.challengeState !== "active" || lifecycle.controlState !== "running") {
        throw new Error("lifecycle transition is forbidden");
      }
      const maybeController = snapshot.maybeWorkerController;
      const maybeRenew = snapshot.transport.renewWorkerLease;
      if (!maybeController || !maybeRenew) {
        throw new Error("Worker Controller renewal is unavailable");
      }
      const maybeAuthorizationContext = snapshot.maybeWorkerLeaseAuthorizationContext
        ? await snapshot.maybeWorkerLeaseAuthorizationContext
            .prepareWorkerLeaseAuthorizationContext("renew")
        : undefined;
      await renewWorkerController(
        maybeController,
        () => maybeRenew(maybeAuthorizationContext),
        snapshot.challenge.challengeId,
        snapshot.transport,
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(structuredClone(lifecycle));
      return () => listeners.delete(listener);
    },
    reportActivityEstimate(activity) {
      if (activity.status === "active") {
        canonicalSafePositiveBigInt(activity.hashrateHs, "Activity Estimate hashrate");
      }
      emit({ type: "activity_estimate", ...activity });
    },
    async close() {
      unsubscribeAuthority();
      unsubscribeWorkerDisconnect?.();
      listeners.clear();
      if (lifecycle.challengeState === "active" && lifecycle.controlState === "running") {
        await shutdownWorkerController(
          snapshot.maybeWorkerController,
          "tab_closed",
          snapshot.transport,
        );
      }
    },
  };
}

function throwIfConsentAborted(
  maybeSignal: AbortSignal | undefined,
  generation: number,
  currentGeneration: number,
): void {
  if (maybeSignal?.aborted || generation !== currentGeneration) {
    throw new Error("trusted consent was aborted");
  }
}

function snapshotInput(input: HeadlessClientInput): Omit<HeadlessClientInput, "claimantIdentity"> {
  return {
    challenge: structuredClone(input.challenge),
    signedPoolOfferSet: structuredClone(input.signedPoolOfferSet),
    authorityTrust: structuredClone(input.authorityTrust),
    selection: structuredClone(input.selection),
    workers: structuredClone(input.workers),
    claimantWorkCeiling: input.claimantWorkCeiling,
    clientSafetyCeiling: input.clientSafetyCeiling,
    transport: input.transport,
    ...(input.maybeWorkerController ? { maybeWorkerController: input.maybeWorkerController } : {}),
    ...(input.maybeWorkerLeaseAuthorizationContext
      ? { maybeWorkerLeaseAuthorizationContext: input.maybeWorkerLeaseAuthorizationContext }
      : {}),
    ...(input.maybeNowUnixSeconds ? { maybeNowUnixSeconds: input.maybeNowUnixSeconds } : {}),
    ...(input.maybeRestoration
      ? { maybeRestoration: structuredClone(input.maybeRestoration) }
      : {}),
  };
}

async function restoredConsent(
  input: HeadlessClientInput,
  maybePersistedReceipt: WorkConsentReceipt | undefined,
  disclosureDigest: string,
  disclosure: WorkConsentDisclosure,
  maybeTrustedConsentRequest: TrustedConsentRequest | undefined,
  nowUnixSeconds: number,
): Promise<WorkConsentReceipt | undefined> {
  if (!input.maybeRestoration) return undefined;
  if (!maybePersistedReceipt) throw new Error("restored work has no persisted Work Consent");
  if (
    maybePersistedReceipt.disclosureDigestSha256 !== disclosureDigest ||
    maybePersistedReceipt.poolOfferSetSignature !== disclosure.poolOfferSetSignature
  ) {
    throw new Error("restored Work Consent does not match the disclosure");
  }
  if (maybeTrustedConsentRequest && !maybePersistedReceipt.maybeTrustedConsentReceipt) {
    throw new Error("restored work lacks required trusted consent");
  }
  if (maybeTrustedConsentRequest && maybePersistedReceipt.maybeTrustedConsentReceipt) {
    await verifyTrustedConsentReceipt(
      maybePersistedReceipt.maybeTrustedConsentReceipt,
      maybeTrustedConsentRequest,
      input.authorityTrust,
      nowUnixSeconds,
    );
  }
  return structuredClone(maybePersistedReceipt);
}

function restoredLifecycle(input: HeadlessClientInput): LifecycleEvent {
  const maybeState = input.maybeRestoration?.challengeState;
  if (!maybeState) {
    return { type: "lifecycle", challengeState: "issued", controlState: "awaiting_consent" };
  }
  if (maybeState === "issued") {
    return { type: "lifecycle", challengeState: maybeState, controlState: "ready" };
  }
  if (maybeState === "active") {
    return { type: "lifecycle", challengeState: maybeState, controlState: "paused" };
  }
  return { type: "lifecycle", challengeState: maybeState, controlState: "completed" };
}

function payoutDestination(selection: PoolSelectionInput): string {
  return selection.payoutDestinationType === "bitcoin_mainnet_address"
    ? selection.bitcoinMainnetAddress
    : selection.beneficiaryId;
}

function claimantKeyMatches(challengeKey: string, preparedKey: string): boolean {
  try {
    return canonicalJson(JSON.parse(challengeKey)) === canonicalJson(JSON.parse(preparedKey));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function authorityLifecycleTransition(
  current: LifecycleEvent,
  next: ChallengeLifecycleState,
): LifecycleEvent {
  if (!challengeTransitionAllowed(current.challengeState, next)) {
    throw new Error("lifecycle transition is forbidden");
  }
  if (next === current.challengeState) return current;
  if (next === "active") {
    if (current.challengeState !== "issued" || current.controlState !== "ready") {
      throw new Error("active work requires restored or recorded Work Consent");
    }
    return { type: "lifecycle", challengeState: "active", controlState: "running" };
  }
  if (next === "satisfied" || next === "pass_issued") {
    return { type: "lifecycle", challengeState: next, controlState: "completed" };
  }
  if (next === "cancelled") {
    return { type: "lifecycle", challengeState: next, controlState: "cancelled" };
  }
  if (next === "expired") {
    return { type: "lifecycle", challengeState: next, controlState: "expired" };
  }
  throw new Error("lifecycle transition is forbidden");
}

function challengeTransitionAllowed(
  from: ChallengeLifecycleState,
  to: ChallengeLifecycleState,
): boolean {
  if (from === to) return true;
  const allowed: Record<ChallengeLifecycleState, readonly ChallengeLifecycleState[]> = {
    issued: ["active", "cancelled", "expired"],
    active: ["satisfied", "pass_issued", "cancelled", "expired"],
    satisfied: ["pass_issued", "expired"],
    pass_issued: ["expired"],
    cancelled: [],
    expired: [],
  };
  return allowed[from].includes(to);
}

export { connectWebSerialHeadlessClient } from "./headless-worker-serial";
