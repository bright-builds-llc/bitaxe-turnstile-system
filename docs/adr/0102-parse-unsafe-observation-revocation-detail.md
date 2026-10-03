# ADR-0102: Parse the Worker's unsafe-observation revocation detail

Accepted for Worker qualification diagnostics. This adds one closed diagnostic
grammar; Controller 0.4, Serial 0.2, Possession 0.2 and the exact-key
`worker-qualification-v1` status are unchanged.

## Context

A firmware Start attempt was revoked as `unsafe_observation` while preparing
the ASIC. The Worker reported only that reason, not which safety fact failed,
its value, or whether the safety samples had stopped. The firmware now emits a
closed `worker_revocation_detail schema=v1 ... redacted=true` line beside its
admission marker. The Gate dropped it, because diagnostic lines without a
grammar are discarded.

## Decision

`maybeWorkerSerialDiagnostic` accepts the line as category
`worker_revocation_detail`, with these fields:
- `generation`;
- `reason`, always `unsafe_observation`;
- `trigger`: `unsafe_sample`, `zero_fan` or `no_safe_sample`;
- `fact`: `none`, `power`, `bus_voltage`, `current`, `chip_temperature` or
  `fan_rpm`;
- `state`: `none`, `expired`, `stale`, `unavailable`, `fault` or
  `out_of_range`;
- `value_milli`: signed 32-bit, or `unavailable`;
- `age_ms`, `since_safe_ms` and `closed_ms`.

A fact and its state are named together, and only the `unsafe_sample` trigger
names a fact. Lines that break these rules are dropped. Export reconstruction
reparses through the same grammar.

The detail is a local, non-authoritative observation like every other
diagnostic. It never admits a session, a Start, a lease or a restoration.

## Consequences

The page and qualification evidence can retain the exact failing fact behind a
device-local revocation. Older firmware does not emit the line, and older Gates
silently drop it, so mixed versions stay compatible.
