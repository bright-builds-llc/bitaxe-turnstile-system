# task-planned-image-history | 2026-09-28 | Retain history across a planned image update

Status: resolved
Blocked by: None

An intentional before-to-candidate image update clears volatile device attempt
history on the next boot. The page must retain its old terminal evidence while
accepting fresh idle status only after exact changed-image controller admission,
unchanged original preservation and released old resources. Ordinary reconnects,
same-image configurations and one-use Start claims keep their existing guards.
No hardware, reflash or mining occurs here.

- [x] Reproduce through the production page, real controller and signed possession.
- [x] Add a guarded private transition without a reset-history API.
- [x] Verify negative image/boot/resource/replay and reconnect cases.
- [x] Run repository checks, review the diff and publish the truthful result.

## Implementation and review

The real page/controller regression reproduced `v2_retained_evidence` when a
released terminal record from boot 9 was followed by first candidate idle status
on boot 10. The page now keeps separate private histories for the before and
candidate images. Only an explicit forward phase with both source and full ELF
changed, successful exact-image admission, original preservation match and a
strictly newer idle boot can establish the candidate history. Old terminal
resources must already be released; a before image with no record also works.

Candidate idle boots may advance monotonically, preserving the existing core
self-test workflow. Once candidate retained evidence exists, its boot and
history become immutable under the existing rules. Old boot or record replay,
configuration rollback, changed identity, active resources, missing preservation
and record mutation/disappearance remain rejected. Both original private history
and the preservation baseline survive. No reset API or work admission is added.

Independent review caught and corrected two overly restrictive idle transitions
before publication. The real page, serial parser, signed possession and reboot
observer now verify a changed-image transition followed by core self-test,
fresh possession and reconnect on the same page. That diagnostic remains
one-use. Ordinary retained-record reconnect and normal Stop tests remain in place.

## Answer

The 24 new focused cases passed independently, and 42 combined image, existing
V2 page and normal Stop regressions passed. Ordered Rust format, Clippy, build and
test checks passed. Final `bun run verify` passed, including all 864 web tests,
real browser conformance, package/build checks and standards. Typecheck,
Markdown and diff checks passed. The unchanged public fixture signing-key helper
was extracted to keep the expanded serial test harness within its file limit.

Independent re-review found no remaining blockers. This is software evidence
only: the previous partial installation stays partial, and firmware-owned fresh
read-only qualification must verify the published bundle before any new effect.
The original mining panic cause remains unknown.
