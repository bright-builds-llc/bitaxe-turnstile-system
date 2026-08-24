import type { LifecycleEvent } from "./headless-client";

export type PresentationMode = "inline" | "modal" | "full-page";

export type AlternativeAuthorization = {
  label: string;
  href: string;
};

export type LifecycleView = {
  status: string;
  tone: "neutral" | "active" | "success" | "warning" | "danger";
  primaryAction: "consent_start" | "start" | "pause" | "resume" | "none";
  canCancel: boolean;
  terminal: boolean;
};

export function presentationSemantics(mode: PresentationMode): {
  role: "region" | "dialog" | "main";
  ariaModal: boolean;
} {
  if (mode === "modal") return { role: "dialog", ariaModal: true };
  if (mode === "full-page") return { role: "region", ariaModal: false };
  return { role: "region", ariaModal: false };
}

export function lifecycleView(event: LifecycleEvent): LifecycleView {
  if (event.challengeState === "issued") {
    return event.controlState === "awaiting_consent"
      ? view("Ready for your consent", "neutral", "consent_start", true, false)
      : view("Consent recorded", "neutral", "start", true, false);
  }
  if (event.challengeState === "active") {
    return event.controlState === "running"
      ? view("Bitcoin work is running", "active", "pause", true, false)
      : view("Bitcoin work is paused", "warning", "resume", true, false);
  }
  if (event.challengeState === "satisfied") {
    return view("Work requirement satisfied", "success", "none", false, true);
  }
  if (event.challengeState === "pass_issued") {
    return view("Gate Pass issued", "success", "none", false, true);
  }
  if (event.challengeState === "expired") {
    return view("Work Challenge expired", "warning", "none", false, true);
  }
  return view("Work Challenge cancelled", "danger", "none", false, true);
}

export function progressView(
  verifiedProgress: string,
  workRequirement: string,
  maybeHashrateHs?: string,
): {
  verifiedValue: number;
  verifiedMaximum: number;
  verifiedLabel: string;
  activityLabel: string;
} {
  const verified = BigInt(verifiedProgress);
  const requirement = BigInt(workRequirement);
  const boundedVerified = verified > requirement ? requirement : verified;
  return {
    verifiedValue: Number(boundedVerified),
    verifiedMaximum: Number(requirement),
    verifiedLabel: `${verified} of ${requirement} expected hashes verified`,
    activityLabel: maybeHashrateHs
      ? `Estimated activity: ${formatGigahashes(maybeHashrateHs)} GH/s`
      : "Estimated activity unavailable",
  };
}

export function fallbackView(alternatives: readonly AlternativeAuthorization[]): {
  heading: string;
  explanation: string;
  alternatives: readonly AlternativeAuthorization[];
} {
  return {
    heading: "Bitcoin work is unavailable",
    explanation:
      "This service may offer a separate alternative authorization path; it is not a successful BWG result.",
    alternatives: structuredClone(alternatives),
  };
}

function view(
  status: string,
  tone: LifecycleView["tone"],
  primaryAction: LifecycleView["primaryAction"],
  canCancel: boolean,
  terminal: boolean,
): LifecycleView {
  return { status, tone, primaryAction, canCancel, terminal };
}

function formatGigahashes(hashrateHs: string): string {
  const wholeGigahashes = BigInt(hashrateHs) / 1_000_000_000n;
  return wholeGigahashes.toString();
}
