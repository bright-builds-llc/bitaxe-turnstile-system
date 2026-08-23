# Domain Docs

This repository uses a deliberate multi-context domain model.

## Before exploring

1. Read `CONTEXT-MAP.md`.
2. Read every linked context glossary relevant to the work.
3. Read the ADRs under `docs/adr/` that affect the work.

If a referenced domain document does not exist, proceed silently. Domain documents are created lazily when terminology or decisions are resolved.

## Layout

- Context map: `CONTEXT-MAP.md`
- Context glossaries: `docs/contexts/<context>/CONTEXT.md`
- System-wide architectural decisions: `docs/adr/`

## Use canonical language

Use glossary terms in issue titles, specifications, code, tests, hypotheses, and review findings. Avoid synonyms explicitly listed under `_Avoid_`.

When required language is missing, either reconsider whether the project needs the concept or invoke `domain-modeling` to resolve it.

## ADR conflicts

Surface any proposed change that contradicts an existing ADR before implementing it. Name the conflicting ADR and explain why reopening the decision may be warranted.
