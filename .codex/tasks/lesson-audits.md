# Lesson Audits

## audit-bitcoin-work-gate-initial-baseline | 2026-08-23T02:49:16Z

- Audit timestamp: `2026-08-23T02:49:16Z`
- Trigger: `no baseline` for the Bitcoin Work Gate active lesson set
- Active source paths:
  - Global: `/Users/peterryszkiewicz/.codex/tasks/lessons.md`
  - Repository: `/Users/peterryszkiewicz/Repos/bitaxe-turnstile-system/.codex/tasks/lessons.md`
- Active lesson counts: global `7`; repository `2`; combined `9`
- Active byte counts: global `5,230`; repository `1,498`; combined `6,728`
- Conservative estimate: `ceil(5,230 / 3) = 1,744` global + `ceil(1,498 / 3) = 500` repository = `2,244` summed estimated tokens
- Retained global lesson IDs: `lesson-use-source-vtt-for-caption-fixes`, `lesson-reproduce-ci-at-exact-boundary`, `lesson-diagnostic-completeness-before-one-shot-attempt`, `lesson-zsh-lowercase-path-mutates-path`, `lesson-macos-host-stalls-separate-policy-from-cache`, `lesson-prefer-exact-row-selection-for-small-dedup`, `lesson-claim-visible-chrome-tab-before-handoff`
- Retained repository lesson IDs: `lesson-separate-pass-expiry-from-idempotent-outcomes`, `lesson-mainnet-acceptance-needs-guardrails-not-a-stage-gate`
- Consolidated lesson IDs: none
- Archived lesson IDs: none
- Archive files created: none
- Next baseline:
  - Timestamp: `2026-08-23T02:49:16Z`; the 90-day changed-lessons trigger becomes eligible on `2026-11-21T02:49:16Z`
  - Counts: global `7`, repository `2`, combined `9`, with `0` new active lessons accumulated; the 10-new trigger occurs after 10 later additions
  - Bytes and estimates: global `5,230` / `1,744`, repository `1,498` / `500`, combined `6,728` / `2,244`
  - Active source SHA-256 values for change detection: global `664021be592cf86593dc360b54c3d21d1d6c6078f5ca5afb74d1dd3dbd8782ef`; repository `e628e1df8b9f2c46d9e174f3139f681eabc7b532157eeee89b1f1030bb958cbb`
  - Threshold state: below both 75% thresholds (`18,000` bytes and `6,000` estimated tokens)
  - Proposed appends must be measured against `24,000` combined bytes and `8,000` summed estimated tokens before writing
