import { expect, test } from "bun:test";
import { readAuthorityStreamEvent } from "./gate-negatives-tab";

test("reads a lifecycle state", () => {
  expect(readAuthorityStreamEvent("challenge_lifecycle", '{"state":"cancelled"}')).toEqual({ type: "lifecycle", state: "cancelled" });
});

test("reads Verified Progress as a whole number", () => {
  expect(readAuthorityStreamEvent("verified_progress", '{"verified_progress":"1024"}')).toEqual({ type: "progress", verifiedProgress: 1024n });
});

test("reads the plain-text resync notice without parsing it as JSON", () => {
  expect(readAuthorityStreamEvent("resync_required", "skipped 3 progress updates")).toEqual({ type: "resync" });
});

test("ignores an event the harness doesn't judge", () => {
  expect(readAuthorityStreamEvent("keep_alive", "not json")).toEqual({ type: "ignored" });
});

test("reports a judged event whose data isn't what the Authority sends", () => {
  expect(readAuthorityStreamEvent("verified_progress", "not json")).toEqual({ type: "malformed", eventName: "verified_progress" });
});
