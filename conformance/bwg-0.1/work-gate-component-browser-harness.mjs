import { createHeadlessClient, prepareClaimantIdentity } from "../../dist/headless/headless-client.js";
import { bitaxeOnboardingFixture } from "./bitaxe-onboarding-browser-fixture.mjs";
import "../../dist/component/bwg-work-gate.js";

const maybeResult = document.querySelector("#result");
const maybeDetails = document.querySelector("#details");

if (!(maybeResult instanceof HTMLOutputElement) || !(maybeDetails instanceof HTMLElement)) {
  throw new Error("component conformance outputs are missing");
}

try {
  const vector = await (await fetch("./work-gate-component-vectors.json")).json();
  const inline = requiredGate("inline");
  const modal = requiredGate("modal");
  const full = requiredGate("full");
  const expired = requiredGate("expired");
  const main = document.querySelector("main");
  if (!main) throw new Error("component conformance main is missing");
  const inlineHarness = await sessionHarness(vector, true);
  const modalHarness = await sessionHarness(vector, false);
  const fullHarness = await sessionHarness(vector, true, { cancelFailures: 1 });
  const expiredHarness = await sessionHarness(vector, true);
  let challengeCreations = 0;
  let accountRedemptions = 0;
  const provenance = {
    sourceUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
    protocolVersion: "BWG/0.1",
    appVersion: "0.1.0",
    maybeShortCommit: "59a1540",
    maybeBuild: "browser-conformance",
    maybeCiUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system/actions/runs/123",
  };
  const alternatives = [{ label: "Use email verification", href: "/email-verification" }];
  const unavailableProvenance = {
    sourceUrl: "",
    protocolVersion: "",
    appVersion: "",
  };
  const unlinkedProvenance = {
    sourceUrl: "https://source.example/project",
    protocolVersion: "BWG/0.1",
    appVersion: "0.1.0",
    maybeShortCommit: "deadbee",
    maybeBuild: "local-build",
  };

  inline.configure({
    alternatives,
    provenance,
    async loadSession() {
      challengeCreations += 1;
      return {
        client: inlineHarness.client,
        compatibleWorkerAvailable: true,
        async redeem() {
          accountRedemptions += 1;
          return { message: "Reference account created" };
        },
      };
    },
  });
  let modalWorkerAvailable = false;
  let onboardingRequests = 0;
  let maybeOnboardingResult;
  const onboardingFixture = await bitaxeOnboardingFixture();
  const modalConfiguration = sessionConfiguration(modalHarness, false, alternatives, provenance);
  modalConfiguration.maybeOnboardBitaxe = async () => {
    onboardingRequests += 1;
    const inspection = await onboardingFixture.onboarding.connect();
    assertEqual(inspection.action, "firmware_required", "bitaxe_firmware_required");
    maybeOnboardingResult = await onboardingFixture.onboarding.install(
      onboardingFixture.firmwarePackage,
    );
    modalWorkerAvailable = maybeOnboardingResult.status === "ready";
  };
  modalConfiguration.loadSession = async () => ({
    client: modalHarness.client,
    compatibleWorkerAvailable: modalWorkerAvailable,
    redeem: async () => ({ message: "Reference account created" }),
  });
  modal.configure(modalConfiguration);
  full.configure(sessionConfiguration(fullHarness, true, alternatives, unlinkedProvenance));
  expired.configure(
    sessionConfiguration(expiredHarness, true, alternatives, unavailableProvenance),
  );
  await waitFor(() => shadow(inline).querySelector("[data-panel=terms]:not([hidden])"));
  await waitFor(() => shadow(modal).querySelector("[data-panel=fallback]:not([hidden])"));

  assertEqual(container(inline).getAttribute("role"), "region", "inline_role");
  assertEqual(container(modal).getAttribute("role"), "dialog", "modal_role");
  assertEqual(container(modal).getAttribute("aria-modal"), "true", "modal_aria");
  assertEqual(container(full).getAttribute("role"), "region", "full_page_role");
  await waitFor(() => shadow(modal).activeElement?.textContent === "Connect Bitaxe over USB");
  assertEqual(
    shadow(modal).activeElement?.textContent,
    "Connect Bitaxe over USB",
    "modal_initial_focus",
  );
  assertEqual(challengeCreations, 1, "plain_html_challenge_creation");
  assertText(shadow(inline), "Expected hashes", "prestart_disclosure");
  assertText(shadow(inline), "Hydra / P2Pool v2", "pool_offer_disclosure");
  assertText(shadow(inline), "AGPL-3.0-or-later", "pool_license_disclosure");
  assertText(shadow(inline), "MIT", "adapter_license_disclosure");
  assertEqual(
    shadow(inline).querySelector("[data-field=pool-source]").href,
    vector.signedPoolOfferSet.offers[0].miningPool.sourceUrl,
    "pool_source_disclosure",
  );
  assertEqual(
    shadow(inline).querySelector("[data-field=adapter-source]").href,
    vector.signedPoolOfferSet.offers[0].poolAdapter.sourceUrl,
    "adapter_source_disclosure",
  );
  assertText(shadow(inline), "95.00%", "reward_allocation_disclosure");
  assertText(shadow(inline), "2.50%", "fee_disclosure");
  assertText(shadow(inline), "no future-revenue claim", "revenue_claim_disclosure");
  assertText(shadow(inline), "no custodial balance", "custody_disclosure");
  assertText(shadow(inline), "ephemeral by default", "payout_privacy_disclosure");
  assertText(shadow(inline), "Open-source Bitcoin research", "beneficiary_disclosure");
  assertText(shadow(inline), "Pause preserves Verified Progress", "cancellation_disclosure");
  assertText(shadow(inline), vector.claimantWorkCeiling, "claimant_ceiling_disclosure");
  assertText(shadow(inline), vector.clientSafetyCeiling, "client_ceiling_disclosure");
  assertText(shadow(inline), "Local Bitaxe", "worker_disclosure");

  click(inline, "Consent and start work");
  await waitFor(() => inlineHarness.calls.includes("start"));
  click(inline, "Pause work");
  await waitFor(() => inlineHarness.calls.includes("pause"));
  await waitFor(() => hasButton(inline, "Resume work"));
  click(inline, "Resume work");
  await waitFor(() => inlineHarness.calls.includes("resume"));
  await inlineHarness.emit({ type: "verified_progress", acceptedHashes: vector.challenge.expectedHashes });
  inlineHarness.client.reportActivityEstimate({ status: "active", hashrateHs: "400000000000" });
  await inlineHarness.emit({ type: "challenge_lifecycle", state: "satisfied" });
  await inlineHarness.emit({ type: "challenge_lifecycle", state: "pass_issued" });
  await waitFor(() => shadow(inline).textContent.includes("Reference account created"));
  assertEqual(accountRedemptions, 1, "plain_html_redemption");
  assertText(shadow(inline), "expected hashes verified", "verified_progress");
  assertText(shadow(inline), "Estimated activity: 400 GH/s", "activity_estimate");

  click(full, "Consent and start work");
  await waitFor(() => fullHarness.calls.includes("start"));
  click(full, "Cancel work");
  await waitFor(() => shadow(full).activeElement?.textContent === "Confirm cancel");
  const cancelDialog = shadow(full).querySelector("[data-panel=cancel-dialog]");
  const backgroundSiblings = [...cancelDialog.parentElement.children]
    .filter((element) => element !== cancelDialog);
  assertEqual(backgroundSiblings.every((element) => element.inert), true, "cancel_background_inert");
  shadow(full).activeElement.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
  );
  assertEqual(shadow(full).activeElement?.textContent, "Keep working", "cancel_focus_wrap");
  click(full, "Keep working");
  click(full, "Cancel work");
  click(full, "Confirm cancel");
  await waitFor(() => shadow(full).textContent.includes("simulated cancel failure"));
  assertEqual(
    shadow(full).querySelector("[data-panel=cancel-dialog]").hidden,
    true,
    "cancel_error_dialog_closed",
  );
  assertEqual(
    shadow(full).querySelector("[data-panel=error]").getAttribute("aria-hidden"),
    null,
    "cancel_error_announced",
  );
  click(full, "Cancel work");
  click(full, "Confirm cancel");
  await waitFor(() => shadow(full).textContent.includes("Work Challenge cancelled"));

  await expiredHarness.emit({ type: "challenge_lifecycle", state: "expired" });
  await waitFor(() => shadow(expired).textContent.includes("Work Challenge expired"));
  assertText(shadow(expired), "Unavailable", "unavailable_provenance");
  assertEqual(
    shadow(expired).querySelector("[data-field=source]").hasAttribute("href"),
    false,
    "unavailable_source_link",
  );
  assertText(shadow(modal), "Bitcoin work is unavailable", "fallback_heading");
  assertText(shadow(modal), "alternative authorization", "fallback_label");
  assertText(shadow(modal), vector.challenge.expectedHashes, "fallback_requirement");
  assertEqual(/human|person/i.test(shadow(modal).textContent), false, "humanity_claim");
  const modalLinks = [...shadow(modal).querySelectorAll("a[href]")]
    .filter((link) => link.getClientRects().length > 0);
  const lastModalLink = modalLinks.at(-1);
  if (!lastModalLink) throw new Error("modal focus fixture has no link");
  lastModalLink.focus();
  lastModalLink.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assertEqual(
    shadow(modal).activeElement,
    visibleButton(modal, "Connect Bitaxe over USB"),
    "modal_focus_wrap",
  );
  const onboardingButton = visibleButton(modal, "Connect Bitaxe over USB");
  onboardingButton.click();
  assertEqual(onboardingButton.disabled, true, "bitaxe_onboarding_single_flight");
  onboardingButton.click();
  await waitFor(() => shadow(modal).querySelector("[data-panel=terms]:not([hidden])"));
  assertEqual(onboardingRequests, 1, "explicit_bitaxe_onboarding");
  assertEqual(onboardingFixture.connector.requestCount(), 1, "bitaxe_usb_request_count");
  assertEqual(onboardingFixture.connector.device().flashCount(), 1, "bitaxe_flash_count");
  assertEqual(maybeOnboardingResult?.status, "ready", "bitaxe_onboarding_ready");
  assertEqual(
    new TextDecoder().decode(onboardingFixture.connector.device().settingsForTest()),
    new TextDecoder().decode(onboardingFixture.settings),
    "bitaxe_settings_preserved",
  );
  assertEqual(
    /secret-network|secret-password/.test(JSON.stringify(maybeOnboardingResult)),
    false,
    "bitaxe_result_redacted",
  );
  await assertIncompatibleFirmwareFailsClosed();
  await assertOnboardingClosesReplacedSession(
    vector,
    alternatives,
    provenance,
    main,
  );
  assertText(shadow(inline), "BWG/0.1", "protocol_provenance");
  assertText(shadow(inline), "0.1.0", "version_provenance");
  assertText(shadow(inline), "59a1540", "commit_provenance");
  assertText(shadow(inline), "Peter Ryszkiewicz", "maintainer_provenance");
  assertEqual(shadow(inline).querySelector("[data-field=source]").href, provenance.sourceUrl, "source_link");
  assertEqual(
    shadow(inline).querySelector("[data-field=commit]").href,
    `${provenance.sourceUrl}/commit/${provenance.maybeShortCommit}`,
    "commit_link",
  );
  assertEqual(
    shadow(inline).querySelector("[data-field=build]").href,
    provenance.maybeCiUrl,
    "build_link",
  );
  assertText(shadow(full), "deadbee", "unlinked_commit_visible");
  assertText(shadow(full), "local-build", "unlinked_build_visible");
  assertEqual(
    shadow(full).querySelector("[data-field=commit]").hasAttribute("href"),
    false,
    "unlinked_commit_has_no_href",
  );
  assertEqual(
    shadow(full).querySelector("[data-field=build]").hasAttribute("href"),
    false,
    "unlinked_build_has_no_href",
  );

  const teardownHarness = await sessionHarness(vector, true);
  const teardownGate = document.createElement("bwg-work-gate");
  main.append(teardownGate);
  let maybeConfirmationSignal;
  let resolveLateReceipt;
  let teardownGrants = 0;
  let teardownStarts = 0;
  const teardownClient = {
    ...teardownHarness.client,
    trustedConsentRequest: () => ({
      reason: "elevated_work",
      authorityOrigin: "https://authority.example",
      challengeId: "challenge_teardown_01",
      disclosureDigestSha256: "A".repeat(43),
      poolOfferSetSignatureSha256: "B".repeat(43),
      expiresAtUnixSeconds: 2_000,
    }),
    async grantConsent() {
      teardownGrants += 1;
    },
    async start() {
      teardownStarts += 1;
    },
  };
  teardownGate.configure({
    alternatives,
    provenance,
    async loadSession() {
      return {
        client: teardownClient,
        compatibleWorkerAvailable: true,
        redeem: async () => ({ message: "unused" }),
      };
    },
    maybeRequestTrustedConsent(_request, signal) {
      maybeConfirmationSignal = signal;
      return new Promise((resolve) => {
        resolveLateReceipt = resolve;
      });
    },
  });
  await waitFor(() => shadow(teardownGate).querySelector("[data-panel=terms]:not([hidden])"));
  click(teardownGate, "Consent and start work");
  await waitFor(() => maybeConfirmationSignal);
  teardownGate.remove();
  assertEqual(maybeConfirmationSignal.aborted, true, "teardown_aborts_trusted_consent");
  if (!resolveLateReceipt) throw new Error("late receipt resolver is missing");
  resolveLateReceipt("late-receipt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(teardownGrants, 0, "teardown_blocks_late_consent");
  assertEqual(teardownStarts, 0, "teardown_blocks_late_start");

  const cancelConsentHarness = await sessionHarness(vector, true);
  const cancelConsentGate = document.createElement("bwg-work-gate");
  main.append(cancelConsentGate);
  let maybeCancelSignal;
  let resolveCancelledReceipt;
  let cancelGrants = 0;
  let cancelStarts = 0;
  const cancelConsentClient = {
    ...cancelConsentHarness.client,
    trustedConsentRequest: teardownClient.trustedConsentRequest,
    async grantConsent() {
      cancelGrants += 1;
    },
    async start() {
      cancelStarts += 1;
    },
  };
  cancelConsentGate.configure({
    alternatives,
    provenance,
    async loadSession() {
      return {
        client: cancelConsentClient,
        compatibleWorkerAvailable: true,
        redeem: async () => ({ message: "unused" }),
      };
    },
    maybeRequestTrustedConsent(_request, signal) {
      maybeCancelSignal = signal;
      return new Promise((resolve) => {
        resolveCancelledReceipt = resolve;
      });
    },
  });
  await waitFor(() => shadow(cancelConsentGate).querySelector("[data-panel=terms]:not([hidden])"));
  click(cancelConsentGate, "Consent and start work");
  await waitFor(() => maybeCancelSignal);
  click(cancelConsentGate, "Cancel work");
  click(cancelConsentGate, "Confirm cancel");
  await waitFor(() => maybeCancelSignal.aborted);
  if (!resolveCancelledReceipt) throw new Error("cancelled receipt resolver is missing");
  resolveCancelledReceipt("late-receipt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(cancelGrants, 0, "cancel_blocks_late_consent");
  assertEqual(cancelStarts, 0, "cancel_blocks_late_start");

  const gateStyle = getComputedStyle(container(full));
  assertEqual(gateStyle.fontSize === "1px", false, "host_style_isolation");
  assertEqual(contrastRatio(gateStyle.color, gateStyle.backgroundColor) >= 4.5, true, "contrast");
  const stylesheet = shadow(inline).querySelector("style")?.textContent ?? "";
  assertEqual(stylesheet.includes("prefers-reduced-motion: reduce"), true, "reduced_motion");
  assertEqual(shadow(inline).querySelector("progress")?.getAttribute("aria-valuetext") !== null, true, "closed_progress_semantics");

  maybeResult.value = "passed";
  maybeResult.dataset.status = "passed";
  maybeDetails.textContent = JSON.stringify({
    modes: ["inline", "modal", "full-page"],
    controls: inlineHarness.calls,
    challengeCreations,
    accountRedemptions,
    accessibility: ["keyboard-focus", "live-status", "contrast", "reduced-motion", "shadow-dom"],
  }, null, 2);
} catch (error) {
  maybeResult.value = "failed";
  maybeResult.dataset.status = "failed";
  maybeDetails.textContent = error instanceof Error ? error.stack : String(error);
}

async function sessionHarness(vector, compatibleWorkerAvailable, options = {}) {
  const clock = () => 1_000;
  const identity = await prepareClaimantIdentity({ maybeClock: clock });
  const calls = [];
  let maybeListener;
  let cancelFailures = options.cancelFailures ?? 0;
  const transport = {
    start: async () => calls.push("start"),
    pause: async () => calls.push("pause"),
    resume: async () => calls.push("resume"),
    cancel: async () => {
      if (cancelFailures > 0) {
        cancelFailures -= 1;
        throw new Error("simulated cancel failure");
      }
      calls.push("cancel");
    },
    subscribeAuthorityEvents(listener) {
      maybeListener = listener;
      return () => {
        maybeListener = undefined;
      };
    },
  };
  const client = await createHeadlessClient({
    ...vector,
    challenge: { ...vector.challenge, claimantKey: identity.claimantKey() },
    claimantIdentity: identity,
    workers: compatibleWorkerAvailable ? vector.workers : [],
    transport,
  });
  return {
    client,
    calls,
    async emit(event) {
      if (!maybeListener) throw new Error("Authority listener is missing");
      await maybeListener(event);
    },
  };
}

function sessionConfiguration(harness, compatibleWorkerAvailable, alternatives, provenance) {
  return {
    alternatives,
    provenance,
    async loadSession() {
      return {
        client: harness.client,
        compatibleWorkerAvailable,
        redeem: async () => ({ message: "Reference account created" }),
      };
    },
  };
}

function requiredGate(id) {
  const element = document.querySelector(`#${id}`);
  if (!element || typeof element.configure !== "function") throw new Error(`gate ${id} is missing`);
  return element;
}

function shadow(element) {
  if (!element.shadowRoot) throw new Error("open Shadow DOM is missing");
  return element.shadowRoot;
}

function container(element) {
  const maybeContainer = shadow(element).querySelector(".gate");
  if (!maybeContainer) throw new Error("gate container is missing");
  return maybeContainer;
}

function click(element, label) {
  visibleButton(element, label).click();
}

function visibleButton(element, label) {
  const button = [...shadow(element).querySelectorAll("button")]
    .find((candidate) => !candidate.hidden && candidate.textContent === label);
  if (!button) throw new Error(`button ${label} is missing`);
  return button;
}

function hasButton(element, label) {
  return [...shadow(element).querySelectorAll("button")]
    .some((candidate) => !candidate.hidden && candidate.textContent === label);
}

function assertText(root, expected, name) {
  if (!root.textContent.includes(expected)) throw new Error(`${name}: missing ${expected}`);
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`);
}

async function waitFor(predicate) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("browser condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertIncompatibleFirmwareFailsClosed() {
  const fixture = await bitaxeOnboardingFixture({
    compatibleBoards: [{ model: "bitaxe-ultra", revisions: ["999"] }],
  });
  await fixture.onboarding.connect();
  let maybeError;
  try {
    await fixture.onboarding.install(fixture.firmwarePackage);
  } catch (error) {
    maybeError = error;
  }
  assertEqual(
    maybeError instanceof Error && maybeError.message.includes("not safely compatible"),
    true,
    "bitaxe_incompatible_rejected",
  );
  assertEqual(fixture.connector.device().flashCount(), 0, "bitaxe_incompatible_not_flashed");
}

async function assertOnboardingClosesReplacedSession(vector, alternatives, provenance, main) {
  const previous = await sessionHarness(vector, false);
  const replacement = await sessionHarness(vector, true);
  let loadCount = 0;
  let previousCloseCount = 0;
  const previousClient = new Proxy(previous.client, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          previousCloseCount += 1;
          await target.close();
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const gate = document.createElement("bwg-work-gate");
  main.append(gate);
  gate.configure({
    alternatives,
    provenance,
    maybeOnboardBitaxe: async () => {},
    async loadSession() {
      loadCount += 1;
      return {
        client: loadCount === 1 ? previousClient : replacement.client,
        compatibleWorkerAvailable: loadCount > 1,
        redeem: async () => ({ message: "unused" }),
      };
    },
  });
  await waitFor(() => shadow(gate).querySelector("[data-panel=fallback]:not([hidden])"));
  click(gate, "Connect Bitaxe over USB");
  await waitFor(() => shadow(gate).querySelector("[data-panel=terms]:not([hidden])"));
  assertEqual(previousCloseCount, 1, "bitaxe_replaced_session_closed");
  gate.remove();

  const failingPrevious = await sessionHarness(vector, false);
  const rejectedReplacement = await sessionHarness(vector, true);
  let failingLoadCount = 0;
  let rejectedReplacementCloseCount = 0;
  const failingPreviousClient = new Proxy(failingPrevious.client, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          throw new Error("simulated previous session close failure");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rejectedReplacementClient = new Proxy(rejectedReplacement.client, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          rejectedReplacementCloseCount += 1;
          await target.close();
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const failureGate = document.createElement("bwg-work-gate");
  main.append(failureGate);
  failureGate.configure({
    alternatives,
    provenance,
    maybeOnboardBitaxe: async () => {},
    async loadSession() {
      failingLoadCount += 1;
      return {
        client: failingLoadCount === 1 ? failingPreviousClient : rejectedReplacementClient,
        compatibleWorkerAvailable: failingLoadCount > 1,
        redeem: async () => ({ message: "unused" }),
      };
    },
  });
  await waitFor(() => shadow(failureGate).querySelector("[data-panel=fallback]:not([hidden])"));
  click(failureGate, "Connect Bitaxe over USB");
  await waitFor(() => shadow(failureGate).textContent.includes("simulated previous session close failure"));
  assertEqual(rejectedReplacementCloseCount, 1, "bitaxe_rejected_replacement_closed");
  assertEqual(
    Boolean(shadow(failureGate).querySelector("[data-panel=fallback]:not([hidden])")),
    true,
    "bitaxe_previous_session_state_preserved",
  );
  failureGate.remove();
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color) {
  const channels = color.match(/[0-9.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`unsupported color ${color}`);
  return channels.map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
