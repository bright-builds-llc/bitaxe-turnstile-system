# Issue Tracker

Specs and tickets for this repository live as version-controlled Markdown under `.scratch/`.

## Layout

- One effort per directory: `.scratch/<effort-slug>/`
- Specification: `.scratch/<effort-slug>/spec.md`
- Tickets: `.scratch/<effort-slug>/issues/<NN>-<slug>.md`
- Use one file per ticket, numbered from `01` in dependency order.
- Record triage state in a `Status:` line near the top.
- Record blocking edges in a `Blocked by:` line.
- Append discussion under `## Comments`.

`.scratch/` is intentionally tracked in Git. Commit relevant specification and ticket-state changes with the planning or implementation work they describe.

## Skill operations

When a skill says “publish to the issue tracker,” create or update the appropriate file under `.scratch/<effort-slug>/`.

When a skill says “fetch the relevant ticket,” read the referenced file. A user may identify it by path, effort name, or ticket number.

The implementation frontier is every open ticket whose blockers are resolved. When several tickets are available, take the lowest-numbered unclaimed ticket.

## Wayfinding

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/<NN>-<slug>.md`
- Ticket type: `Type: research|prototype|grilling|task`
- Ticket state: `Status: open|claimed|resolved`
- Blocking: `Blocked by: <NN>, <NN>` or `Blocked by: None`
- Claim: set `Status: claimed` before beginning work.
- Resolve: append the result under `## Answer`, set `Status: resolved`, and add a concise context pointer to the map’s `## Decisions so far`.
