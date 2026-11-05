# Web Serial onboarding device

Type: task
Status: ready-for-agent
Blocked by: 02

## Objective

Add a production `BitaxeOnboardingDevice` over the existing granted Web Serial
port, so `bwg-core/bitaxe-onboarding` can inspect and install on a real board.
Today only `web/simulated-bitaxe-onboarding.ts` implements it.

## Plan

- [ ] Strict parsers for Ticket 02's replies, with the existing redaction and
  size bounds.
- [ ] Reuse one granted port across onboarding and the Worker Controller (ADR-0101).
- [ ] Update the onboarding simulator to Ticket 02's contract and run the browser
  conformance fixture against it, including refusal before any write.
- [ ] Wire the component's "Connect Bitaxe over USB" path to it, and run
  `bun run verify`.

## Comments
