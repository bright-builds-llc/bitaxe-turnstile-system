import { describe, expect, test } from "bun:test";

import {
  fallbackView,
  lifecycleView,
  presentationSemantics,
  progressView,
} from "./work-gate-view-model";

describe("presentation semantics", () => {
  test("assigns distinct accessible containers to every presentation mode", () => {
    // Arrange / Act / Assert
    expect(presentationSemantics("inline")).toEqual({ role: "region", ariaModal: false });
    expect(presentationSemantics("modal")).toEqual({ role: "dialog", ariaModal: true });
    expect(presentationSemantics("full-page")).toEqual({ role: "region", ariaModal: false });
  });
});

describe("lifecycle view", () => {
  test("offers explicit consent before issued work can start", () => {
    // Arrange / Act
    const view = lifecycleView({
      type: "lifecycle",
      challengeState: "issued",
      controlState: "awaiting_consent",
    });

    // Assert
    expect(view).toEqual({
      status: "Ready for your consent",
      tone: "neutral",
      primaryAction: "consent_start",
      canCancel: true,
      terminal: false,
    });
  });

  test("distinguishes running and paused controls", () => {
    // Arrange / Act / Assert
    expect(
      lifecycleView({
        type: "lifecycle",
        challengeState: "active",
        controlState: "running",
      }).primaryAction,
    ).toBe("pause");
    expect(
      lifecycleView({
        type: "lifecycle",
        challengeState: "active",
        controlState: "paused",
      }).primaryAction,
    ).toBe("resume");
  });

  test("offers Start after consent is durably recorded", () => {
    // Arrange / Act
    const view = lifecycleView({
      type: "lifecycle",
      challengeState: "issued",
      controlState: "ready",
    });

    // Assert
    expect(view).toMatchObject({ status: "Consent recorded", primaryAction: "start" });
  });

  test("labels satisfied work as terminal success before pass issuance", () => {
    // Arrange / Act
    const view = lifecycleView({
      type: "lifecycle",
      challengeState: "satisfied",
      controlState: "completed",
    });

    // Assert
    expect(view).toMatchObject({ status: "Work requirement satisfied", terminal: true });
  });

  test("maps completed, cancelled, and expired states without resumability", () => {
    // Arrange / Act / Assert
    expect(
      lifecycleView({
        type: "lifecycle",
        challengeState: "pass_issued",
        controlState: "completed",
      }),
    ).toMatchObject({ tone: "success", terminal: true, primaryAction: "none" });
    expect(
      lifecycleView({
        type: "lifecycle",
        challengeState: "cancelled",
        controlState: "cancelled",
      }),
    ).toMatchObject({ tone: "danger", terminal: true, primaryAction: "none" });
    expect(
      lifecycleView({
        type: "lifecycle",
        challengeState: "expired",
        controlState: "expired",
      }),
    ).toMatchObject({ tone: "warning", terminal: true, primaryAction: "none" });
  });
});

describe("progress and fallback view", () => {
  test("keeps exact Verified Progress separate from Activity Estimate", () => {
    // Arrange / Act
    const view = progressView("20", "100", "400000000000");

    // Assert
    expect(view).toEqual({
      verifiedValue: 20,
      verifiedMaximum: 100,
      verifiedLabel: "20 of 100 expected hashes verified",
      activityLabel: "Estimated activity: 400 GH/s",
    });
  });

  test("clamps the progress control while preserving the exact over-requirement label", () => {
    // Arrange / Act
    const view = progressView("120", "100", "1000000000");

    // Assert
    expect(view.verifiedValue).toBe(100);
    expect(view.verifiedLabel).toBe("120 of 100 expected hashes verified");
  });

  test("labels unavailable Activity Estimate independently", () => {
    // Arrange / Act
    const view = progressView("0", "100");

    // Assert
    expect(view.activityLabel).toBe("Estimated activity unavailable");
  });

  test("labels configured alternatives without making a humanity claim", () => {
    // Arrange / Act
    const view = fallbackView([{ label: "Use email verification", href: "/email" }]);

    // Assert
    expect(view.heading).toBe("Bitcoin work is unavailable");
    expect(view.explanation).toContain("alternative authorization");
    expect(`${view.heading} ${view.explanation}`).not.toMatch(/human|person/i);
    expect(view.alternatives).toHaveLength(1);
  });
});
