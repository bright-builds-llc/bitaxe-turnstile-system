import { createEffect, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";

import type {
  HeadlessClient,
  HeadlessEvent,
  LifecycleEvent,
  WorkConsentDisclosure,
} from "./headless-client";
import workGateStyles from "./bwg-work-gate.css" with { type: "text" };
import markup from "./bwg-work-gate.template.html" with { type: "text" };
import {
  fallbackView,
  lifecycleView,
  presentationSemantics,
  progressView,
  type AlternativeAuthorization,
  type PresentationMode,
} from "./work-gate-view-model";

export type WorkGateSession = {
  client: HeadlessClient;
  compatibleWorkerAvailable: boolean;
  redeem(): Promise<{ message: string }>;
};

export type WorkGateConfiguration = {
  loadSession(): Promise<WorkGateSession>;
  alternatives: readonly AlternativeAuthorization[];
  provenance: {
    sourceUrl: string;
    protocolVersion: string;
    appVersion: string;
    maybeShortCommit?: string;
    maybeCommitUrl?: string;
    maybeBuild?: string;
    maybeCiUrl?: string;
  };
};

const defaultTagName = "bwg-work-gate";

export class BwgWorkGateElement extends HTMLElement {
  static observedAttributes = ["presentation"];

  readonly #shadow: ShadowRoot;
  #maybeConfiguration?: WorkGateConfiguration;
  #maybeDispose: (() => void) | undefined;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
  }

  configure(configuration: WorkGateConfiguration): void {
    this.#maybeConfiguration = configuration;
    if (this.isConnected) this.#mount();
  }

  connectedCallback(): void {
    this.#mount();
  }

  disconnectedCallback(): void {
    this.#maybeDispose?.();
    this.#maybeDispose = undefined;
  }

  attributeChangedCallback(): void {
    if (this.isConnected && this.#maybeConfiguration && !this.#maybeDispose) this.#mount();
  }

  #mount(): void {
    this.#maybeDispose?.();
    this.#maybeDispose = undefined;
    const maybeConfiguration = this.#maybeConfiguration;
    if (!maybeConfiguration) {
      this.#shadow.innerHTML = `<style>${workGateStyles}</style><p role="status">Waiting for configuration.</p>`;
      return;
    }
    this.#shadow.replaceChildren();
    const presentation = parsePresentation(this.getAttribute("presentation"));
    this.#maybeDispose = render(
      () => createWorkGateView(maybeConfiguration, presentation),
      this.#shadow,
    );
  }
}

export function registerBwgWorkGate(tagName = defaultTagName): void {
  if (!customElements.get(tagName)) customElements.define(tagName, BwgWorkGateElement);
}

if (typeof customElements !== "undefined") registerBwgWorkGate();

function createWorkGateView(
  configuration: WorkGateConfiguration,
  presentation: PresentationMode,
): HTMLElement {
  const root = document.createElement("section");
  root.innerHTML = String(markup);
  root.prepend(styleElement());
  const semantics = presentationSemantics(presentation);
  const gate = requiredElement<HTMLElement>(root, ".gate");
  gate.dataset.presentation = presentation;
  gate.setAttribute("role", semantics.role);
  gate.setAttribute("aria-labelledby", "bwg-title");
  if (semantics.ariaModal) gate.setAttribute("aria-modal", "true");
  gate.tabIndex = -1;

  const [maybeSession, setMaybeSession] = createSignal<WorkGateSession>();
  const [maybeDisclosure, setMaybeDisclosure] = createSignal<WorkConsentDisclosure>();
  const [maybeLifecycle, setMaybeLifecycle] = createSignal<LifecycleEvent>();
  const [verifiedProgress, setVerifiedProgress] = createSignal("0");
  const [maybeActivity, setMaybeActivity] = createSignal<string>();
  const [maybeOutcome, setMaybeOutcome] = createSignal<string>();
  const [maybeError, setMaybeError] = createSignal<string>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [confirmingCancel, setConfirmingCancel] = createSignal(false);
  let maybeUnsubscribe: (() => void) | undefined;
  let disposed = false;
  let redemptionStarted = false;

  const primary = requiredElement<HTMLButtonElement>(root, "[data-action=primary]");
  const cancel = requiredElement<HTMLButtonElement>(root, "[data-action=cancel]");
  const confirmCancel = requiredElement<HTMLButtonElement>(root, "[data-action=confirm-cancel]");
  const keepWorking = requiredElement<HTMLButtonElement>(root, "[data-action=keep-working]");
  const cancelDialog = requiredElement<HTMLElement>(root, "[data-panel=cancel-dialog]");

  const run = async (operation: () => Promise<void>) => {
    setMaybeError(undefined);
    try {
      await operation();
    } catch (error) {
      setMaybeError(error instanceof Error ? error.message : "The BWG operation failed");
    }
  };

  primary.addEventListener("click", () => {
    void run(async () => {
      const maybeSessionValue = maybeSession();
      const maybeLifecycleValue = maybeLifecycle();
      if (!maybeSessionValue || !maybeLifecycleValue) return;
      const action = lifecycleView(maybeLifecycleValue).primaryAction;
      if (action === "consent_start") {
        await maybeSessionValue.client.grantConsent();
        await maybeSessionValue.client.start();
      } else if (action === "start") {
        await maybeSessionValue.client.start();
      } else if (action === "pause") {
        await maybeSessionValue.client.pause();
      } else if (action === "resume") {
        await maybeSessionValue.client.resume();
      }
    });
  });
  cancel.addEventListener("click", () => {
    setConfirmingCancel(true);
    queueMicrotask(() => confirmCancel.focus());
  });
  keepWorking.addEventListener("click", () => {
    setConfirmingCancel(false);
    cancel.focus();
  });
  confirmCancel.addEventListener("click", () => {
    void (async () => {
      setMaybeError(undefined);
      try {
        await maybeSession()?.client.cancel();
        setConfirmingCancel(false);
      } catch (error) {
        setConfirmingCancel(false);
        setMaybeError(error instanceof Error ? error.message : "Cancel failed");
        queueMicrotask(() => cancel.focus());
      }
    })();
  });
  gate.addEventListener("keydown", (event) => trapModalFocus(event, gate, presentation));
  cancelDialog.addEventListener("keydown", (event) => trapFocus(event, cancelDialog));

  createEffect(() => updateView(root, {
    maybeDisclosure: maybeDisclosure(),
    maybeLifecycle: maybeLifecycle(),
    verifiedProgress: verifiedProgress(),
    maybeActivity: maybeActivity(),
    maybeOutcome: maybeOutcome(),
    maybeError: maybeError(),
    unavailable: unavailable(),
    confirmingCancel: confirmingCancel(),
    alternatives: configuration.alternatives,
    provenance: configuration.provenance,
  }));

  void configuration.loadSession().then((session) => {
    if (disposed) return;
    setMaybeSession(session);
    setMaybeDisclosure(session.client.disclosure());
    setUnavailable(!session.compatibleWorkerAvailable);
    maybeUnsubscribe = session.client.subscribe((event) => {
      observeClientEvent(event);
      if (event.type === "lifecycle" && event.challengeState === "pass_issued") {
        void redeem(session);
      }
    });
    if (presentation === "modal") {
      requestAnimationFrame(() => focusableElements(gate)[0]?.focus());
    }
  }).catch((error: unknown) => {
    if (!disposed) setMaybeError(error instanceof Error ? error.message : "Unable to load BWG");
  });

  function observeClientEvent(event: HeadlessEvent): void {
    if (event.type === "lifecycle") setMaybeLifecycle(event);
    if (event.type === "verified_progress") setVerifiedProgress(event.verifiedProgress);
    if (event.type === "activity_estimate") {
      setMaybeActivity(event.status === "active" ? event.hashrateHs : undefined);
    }
  }

  async function redeem(session: WorkGateSession): Promise<void> {
    if (redemptionStarted) return;
    redemptionStarted = true;
    await run(async () => {
      const outcome = await session.redeem();
      setMaybeOutcome(outcome.message);
    });
  }

  onCleanup(() => {
    disposed = true;
    maybeUnsubscribe?.();
    maybeSession()?.client.close();
  });
  return root;
}

type ViewState = {
  maybeDisclosure: WorkConsentDisclosure | undefined;
  maybeLifecycle: LifecycleEvent | undefined;
  verifiedProgress: string;
  maybeActivity: string | undefined;
  maybeOutcome: string | undefined;
  maybeError: string | undefined;
  unavailable: boolean;
  confirmingCancel: boolean;
  alternatives: readonly AlternativeAuthorization[];
  provenance: WorkGateConfiguration["provenance"];
};

function updateView(root: HTMLElement, state: ViewState): void {
  const loading = !state.maybeDisclosure && !state.maybeError;
  requiredElement<HTMLElement>(root, ".gate").setAttribute("aria-busy", String(loading));
  toggle(root, "[data-panel=loading]", loading);
  toggle(root, "[data-panel=terms]", Boolean(state.maybeDisclosure) && !state.unavailable);
  toggle(root, "[data-panel=fallback]", state.unavailable);
  toggle(root, "[data-panel=error]", Boolean(state.maybeError));
  toggle(root, "[data-panel=outcome]", Boolean(state.maybeOutcome));
  toggle(root, "[data-panel=cancel-dialog]", state.confirmingCancel);
  const cancelDialog = requiredElement<HTMLElement>(root, "[data-panel=cancel-dialog]");
  const gate = requiredElement<HTMLElement>(root, ".gate");
  for (const child of Array.from(gate.children)) {
    if (!(child instanceof HTMLElement) || child === cancelDialog) continue;
    child.inert = state.confirmingCancel;
    if (state.confirmingCancel) child.setAttribute("aria-hidden", "true");
    else child.removeAttribute("aria-hidden");
  }
  text(root, "[data-field=error]", state.maybeError ?? "");
  text(root, "[data-field=outcome]", state.maybeOutcome ?? "");
  renderProvenance(root, state.provenance);
  if (state.unavailable) renderFallback(root, state.alternatives, state.maybeDisclosure);
  if (!state.maybeDisclosure) return;
  renderDisclosure(root, state.maybeDisclosure);
  const maybeLifecycleValue = state.maybeLifecycle;
  if (!maybeLifecycleValue) return;
  const lifecycleModel = lifecycleView(maybeLifecycleValue);
  const status = requiredElement<HTMLElement>(root, "[data-field=status]");
  status.dataset.tone = lifecycleModel.tone;
  text(root, "[data-field=status-text]", lifecycleModel.status);
  const progress = progressView(
    state.verifiedProgress,
    state.maybeDisclosure.expectedHashes,
    state.maybeActivity,
  );
  const progressElement = requiredElement<HTMLProgressElement>(root, "progress");
  progressElement.max = progress.verifiedMaximum;
  progressElement.value = progress.verifiedValue;
  progressElement.setAttribute("aria-valuetext", progress.verifiedLabel);
  text(root, "[data-field=progress]", progress.verifiedLabel);
  text(root, "[data-field=activity]", progress.activityLabel);
  const primary = requiredElement<HTMLButtonElement>(root, "[data-action=primary]");
  primary.hidden = lifecycleModel.primaryAction === "none";
  primary.textContent = actionLabel(lifecycleModel.primaryAction);
  const cancel = requiredElement<HTMLButtonElement>(root, "[data-action=cancel]");
  cancel.hidden = !lifecycleModel.canCancel;
}

function renderDisclosure(root: HTMLElement, disclosure: WorkConsentDisclosure): void {
  text(root, "[data-field=work]", disclosure.expectedHashes);
  text(root, "[data-field=bits]", disclosure.equivalentBinaryZeroWork.toFixed(2));
  text(
    root,
    "[data-field=duration]",
    disclosure.maybeDurationSeconds === undefined
      ? "Unavailable"
      : `${disclosure.maybeDurationSeconds.toFixed(1)} seconds estimated`,
  );
  text(
    root,
    "[data-field=energy]",
    disclosure.maybeEnergyWattHours === undefined
      ? "Unavailable"
      : `${disclosure.maybeEnergyWattHours.toFixed(3)} Wh estimated`,
  );
  text(root, "[data-field=pool]", componentIdentity(disclosure.poolOffer.miningPool));
  text(root, "[data-field=adapter]", componentIdentity(disclosure.poolOffer.poolAdapter));
  setOptionalLink(
    requiredElement<HTMLAnchorElement>(root, "[data-field=pool-source]"),
    disclosure.poolOffer.miningPool.sourceUrl,
    "Mining Pool source",
  );
  setOptionalLink(
    requiredElement<HTMLAnchorElement>(root, "[data-field=adapter-source]"),
    disclosure.poolOffer.poolAdapter.sourceUrl,
    "Pool Adapter source",
  );
  text(
    root,
    "[data-field=transport]",
    `${disclosure.poolOffer.miningTransport} · ${disclosure.poolOffer.endpoint}`,
  );
  text(
    root,
    "[data-field=reward]",
    `${basisPoints(disclosure.rewardPolicy.selectedDestinationBasisPoints)} to the selected destination`,
  );
  text(root, "[data-field=pool-fee]", basisPoints(disclosure.rewardPolicy.poolFeeBasisPoints));
  text(root, "[data-field=service-fee]", basisPoints(disclosure.rewardPolicy.serviceFeeBasisPoints));
  text(root, "[data-field=network-result]", "Network-valid work pays by direct coinbase");
  text(
    root,
    "[data-field=revenue-claim]",
    disclosure.rewardPolicy.acceptedWorkCreatesRevenueClaim
      ? "Accepted work creates a future-revenue claim"
      : "Accepted work creates no future-revenue claim",
  );
  text(
    root,
    "[data-field=custody]",
    disclosure.rewardPolicy.createsCustodialBalance
      ? "The service creates a custodial balance"
      : "The service creates no custodial balance",
  );
  text(
    root,
    "[data-field=payout-types]",
    disclosure.poolOffer.payoutRequirements.acceptedDestinationTypes.join(", "),
  );
  text(root, "[data-field=payout]", disclosure.payoutDestination);
  text(
    root,
    "[data-field=ephemeral-payout]",
    disclosure.poolOffer.payoutRequirements.ephemeralByDefault
      ? "Payout selection is ephemeral by default"
      : "Payout selection may persist",
  );
  renderBeneficiaries(root, disclosure);
  text(root, "[data-field=workers]", disclosure.workers.map((worker) => worker.displayName).join(", "));
  text(root, "[data-field=claimant-ceiling]", disclosure.claimantWorkCeiling);
  text(root, "[data-field=client-ceiling]", disclosure.clientSafetyCeiling);
  text(
    root,
    "[data-field=cancellation]",
    "Pause preserves Verified Progress; Cancel is terminal.",
  );
  const privacy = requiredElement<HTMLAnchorElement>(root, "[data-field=privacy]");
  privacy.href = disclosure.poolOffer.privacyTermsUrl;
  const operatorTerms = requiredElement<HTMLAnchorElement>(root, "[data-field=operator-terms]");
  operatorTerms.href = disclosure.poolOffer.operatorTermsUrl;
}

function renderBeneficiaries(root: HTMLElement, disclosure: WorkConsentDisclosure): void {
  const container = requiredElement<HTMLElement>(root, "[data-field=beneficiaries]");
  const beneficiaries = disclosure.poolOffer.payoutRequirements.approvedBeneficiaries;
  if (beneficiaries.length === 0) {
    container.textContent = "None";
    return;
  }
  container.replaceChildren(...beneficiaries.map((beneficiary) => {
    const link = document.createElement("a");
    link.href = beneficiary.termsUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${beneficiary.displayName} (${beneficiary.beneficiaryId})`;
    return link;
  }));
}

function componentIdentity(component: WorkConsentDisclosure["poolOffer"]["miningPool"]): string {
  return `${component.displayName} ${component.version} · ${component.license}`;
}

function basisPoints(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function renderFallback(
  root: HTMLElement,
  alternatives: readonly AlternativeAuthorization[],
  maybeDisclosure: WorkConsentDisclosure | undefined,
): void {
  const model = fallbackView(alternatives);
  text(root, "[data-field=fallback-heading]", model.heading);
  text(root, "[data-field=fallback-explanation]", model.explanation);
  text(
    root,
    "[data-field=fallback-requirement]",
    maybeDisclosure
      ? `This action requires ${maybeDisclosure.expectedHashes} expected hashes.`
      : "The exact work requirement is unavailable.",
  );
  const list = requiredElement<HTMLElement>(root, "[data-field=alternatives]");
  list.replaceChildren(...model.alternatives.map((alternative) => {
    const link = document.createElement("a");
    link.className = "alternative";
    link.href = alternative.href;
    link.textContent = alternative.label;
    return link;
  }));
}

function renderProvenance(root: HTMLElement, provenance: WorkGateConfiguration["provenance"]): void {
  const source = requiredElement<HTMLAnchorElement>(root, "[data-field=source]");
  setOptionalLink(
    source,
    provenance.sourceUrl,
    provenance.sourceUrl ? "Source" : "Source unavailable",
  );
  text(root, "[data-field=protocol]", valueOrUnavailable(provenance.protocolVersion));
  text(root, "[data-field=app-version]", valueOrUnavailable(provenance.appVersion));
  const commit = requiredElement<HTMLAnchorElement>(root, "[data-field=commit]");
  const maybeCommitUrl = provenance.maybeCommitUrl ??
    (provenance.maybeShortCommit && provenance.sourceUrl.startsWith("https://github.com/")
      ? `${provenance.sourceUrl.replace(/\/$/u, "")}/commit/${provenance.maybeShortCommit}`
      : undefined);
  setOptionalLink(
    commit,
    maybeCommitUrl,
    valueOrUnavailable(provenance.maybeShortCommit),
  );
  const build = requiredElement<HTMLAnchorElement>(root, "[data-field=build]");
  setOptionalLink(
    build,
    provenance.maybeCiUrl,
    valueOrUnavailable(provenance.maybeBuild),
  );
}

function setOptionalLink(
  link: HTMLAnchorElement,
  maybeHref: string | undefined,
  label: string,
): void {
  link.textContent = label;
  if (maybeHref) link.href = maybeHref;
  else link.removeAttribute("href");
}

function valueOrUnavailable(maybeValue: string | undefined): string {
  return maybeValue?.trim() ? maybeValue : "Unavailable";
}

function actionLabel(action: ReturnType<typeof lifecycleView>["primaryAction"]): string {
  if (action === "consent_start") return "Consent and start work";
  if (action === "start") return "Start work";
  if (action === "pause") return "Pause work";
  if (action === "resume") return "Resume work";
  return "";
}

function trapModalFocus(event: KeyboardEvent, gate: HTMLElement, mode: PresentationMode): void {
  if (mode !== "modal") return;
  trapFocus(event, gate);
}

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== "Tab") return;
  const focusable = focusableElements(container);
  const maybeFirst = focusable[0];
  const maybeLast = focusable.at(-1);
  if (!maybeFirst || !maybeLast) return;
  const rootNode = container.getRootNode();
  const maybeActiveElement = rootNode instanceof ShadowRoot
    ? rootNode.activeElement
    : document.activeElement;
  if (event.shiftKey && maybeActiveElement === maybeFirst) {
    event.preventDefault();
    maybeLast.focus();
  } else if (!event.shiftKey && maybeActiveElement === maybeLast) {
    event.preventDefault();
    maybeFirst.focus();
  }
}

function focusableElements(gate: HTMLElement): HTMLElement[] {
  return Array.from(
    gate.querySelectorAll<HTMLElement>("button:not([hidden]), a[href]"),
  )
    .filter(
      (element) =>
        !element.hasAttribute("disabled") && element.getClientRects().length > 0,
    );
}

function parsePresentation(maybeValue: string | null): PresentationMode {
  return maybeValue === "modal" || maybeValue === "full-page" ? maybeValue : "inline";
}

function styleElement(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = workGateStyles;
  return style;
}

function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const maybeElement = root.querySelector<T>(selector);
  if (!maybeElement) throw new Error(`BWG component template is missing ${selector}`);
  return maybeElement;
}

function toggle(root: ParentNode, selector: string, visible: boolean): void {
  requiredElement<HTMLElement>(root, selector).hidden = !visible;
}

function text(root: ParentNode, selector: string, value: string): void {
  requiredElement<HTMLElement>(root, selector).textContent = value;
}
