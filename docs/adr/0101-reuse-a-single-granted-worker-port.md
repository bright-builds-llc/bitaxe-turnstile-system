# ADR-0101: Reuse a single granted Worker port on Connect

Accepted for the owner-authorized Worker qualification path. This changes only how
Connect obtains a `SerialPort`; Controller 0.4, Serial 0.2 and Possession 0.2 are
unchanged.

## Context

Connect called `navigator.serial.requestPort()` every time, so each reconnect
showed Chrome's port chooser. That chooser is browser UI outside the page, which
neither page automation nor desktop automation can operate. Qualification runs
with an install, four update cycles and a restore therefore needed a person at the
chooser about seven times.

The chooser never carried authority. USB vendor and product IDs are admission
hints; authority comes from fresh Device Identity possession over a fresh Hello
(ADR-0094). Chrome keeps an origin's grant for a device across re-enumeration, so
the granted port is still the admitted physical device after a reflash.

## Decision

On Connect, `selectWorkerPort` lists the origin's granted ports. When exactly one
granted port is attached and matches the Worker vendor and product IDs, Connect
reuses it without a chooser. With no such port, several such ports, or an
unavailable listing, Connect calls `requestPort()` with the same filter, as before.

Everything after selection is unchanged:
- the trusted user gesture, foreground and active-activation checks before
  selection;
- the Web Lock;
- the exact device-filter check on the selected port;
- scope preparation;
- the open, fresh Hello and possession;
- every failure category and cleanup path.

Reuse never makes a port authoritative, never skips possession, and never connects
without a Connect gesture.

## Consequences

A reconnect to the same single Worker needs no chooser, so an agent operating the
page can perform every Connect. Several Workers granted to one origin still need
the chooser to pick one. Revoking the site's serial permission in Chrome restores
the chooser for every Connect.
