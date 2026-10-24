# ADR-0104: Reference Firmware capabilities admit the Ultra 205 and the Gamma 601

Accepted 2026-10-24, alongside firmware ADR-0041
(`bitaxe-esp-miner/docs/adr/0041-multi-board-support-and-board-identity.md`).
Controller 0.4, Serial 0.2, Possession 0.2 and Deployment Trust 0.2 keep
their profile identifiers.

## Context

The Update Authority signs a `bwg-reference-firmware-capability/0.2` claim
that names the Worker's board. The deployment trust contract fixed that board
to `bitaxe-ultra` revision `205`, while the Controller 0.4 contract, the
signer and Worker admission accepted any bounded label. The owner chose the
Gamma 601's identity as model `bitaxe-gamma`, revision `601`.

## Decision

1. **A closed set.** A Reference Firmware capability states exactly one of
   (`bitaxe-ultra`, `205`) or (`bitaxe-gamma`, `601`).
   `web/reference-firmware-board.ts` owns the set. Model and revision travel
   together, so a mixed pair such as (`bitaxe-ultra`, `601`) is refused.
2. **Every check uses it.** The Controller 0.4 and Deployment Trust 0.2
   schemas pair the two values with `oneOf`.
   `signWorkerControllerCapability` refuses any other board before it signs.
   Worker admission, `verifyWorkerControllerCapability`, refuses any other
   board even under a valid Update Authority signature.
3. **The signer names its board.** `scripts/worker-development-authority.ts
   sign-capability` takes an optional `--board 205|601`, defaulting to `205`
   so existing callers keep working. It refuses an unknown board, or an input
   whose board differs from the named one, and prints
   `worker_capability=signed board=<revision>`.
4. **Package admission is unchanged.** Onboarding still installs a firmware
   package only when its `compatibleBoards` names the device's exact model
   and revision.

## Consequences

- The shared fixtures stay 205-only. The Gamma 601 capability is signed by
  the deployment's Update Authority on the owner's machine, not by
  conformance keys.
- A Gate built from this change admits Ultra 205 Workers exactly as before.
  A firmware repository that pins it can embed a signed Gamma 601
  capability next to the 205 one.
- A further board needs a new ADR and a change to the closed set.
