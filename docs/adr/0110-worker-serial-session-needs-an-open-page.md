# ADR-0110: A Worker Serial session needs an open page, not a visible one

Accepted 2026-11-08, on the owner's choice after Ticket 07. It supersedes only
the foreground clause of ADR-0094 ("Losing foreground ownership ... requires a
new explicit admission"). The rest of ADR-0094 stands. The acceptance-campaign
records (ADRs 0095, 0097, 0098 and 0099) describe windows already run and stay
as history, and ADR-0101's gesture checks at Connect are unchanged.

A Bitaxe works for minutes. Ending its session whenever the Claimant switches
tab, window or app made the Claimant watch the page for the whole Work
Requirement. In Ticket 07, two runs on the Gamma 601 lost their restoration
because the tab stopped sending heartbeats while it was out of view.

From now on:

- Connect still needs a visible, focused page and a user gesture, so Work
  Consent and port selection stay deliberate.
- After admission, the session lasts while the page is open. Hiding, minimizing
  or covering the tab does not end it. Closing the tab, navigating away or
  reloading (`pagehide`) still ends it, and returning never resumes mining.
- The page's heartbeat clock, write deadlines and renew cadence run on a
  dedicated Web Worker's timers (`web/page-clock.ts`). In Chrome 156 with
  default settings and a minimized window, the page's own timers reached
  60-second gaps within minutes, while the Worker's stayed within 1.4 seconds
  and the page handled its messages within 1.3 seconds. Where a Worker can't be
  created, the page's own timers are used, as before.
- The firmware is unchanged: one-second heartbeats, the 2.8-second deadline and
  the three-second stop. If the browser does freeze or discard the page, the
  board stops on that deadline, as it does for a lost cable.
- The signed manifest keeps `foregroundOnly: true` on the wire. It now means
  that one page, admitted by a foreground gesture, owns the session; it does not
  require that page to stay visible.
- The qualification purpose `foreground_loss` keeps its name and wire value. Its
  fault is now produced by leaving the page rather than hiding it.

## Considered options

- **Keep the foreground rule** and tell Claimants to keep the tab in view. It
  was the failure Ticket 07 hit.
- **Move the serial link itself into the Worker.** Chrome exposes
  `navigator.serial` there, but the port grant and chooser live in the page,
  and the move would rewrite the controller. A Worker clock driving the page's
  link gave unthrottled timing for far less change; this can be revisited if
  Chrome starts deferring page tasks in hidden tabs.
