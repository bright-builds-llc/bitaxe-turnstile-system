# Normal Stop authorization recovery

The V2 Share acceptance page retains a private expected authorization high-water
fingerprint from each successful Start or Renew response. A response must contain
new preservation and qualification observations from that exact operation. A
stale callback, absent preservation or changed work generation fails the boundary
and closes the controller; an observed unexpected high-water change cannot be
cleared by subsequently returning to the expected value.

`workerAcceptance.stop()` sends the ordinary bounded Restore immediately. After
its validated baseline response, it compares that response against the last known
post-authorization fingerprint and generation, then creates the existing
`worker-authorization-recovery-v1` checkpoint. No extra read delays Stop, and no
fingerprint is constructed from public page state or exported to the supervisor.
Idle Stop on a page that never completed Start does not create a checkpoint.

The supervisor should retain the checkpoint ID and generation, Close, reconnect
on the same page, and require `authorizationRecovery.matched === true` from fresh
private observations. Missing, advanced, rolled-back or wrong-generation state
cannot match. Repeated Stop/Close during recovery retains the original checkpoint
ID and comparison result. An existing heartbeat-fault checkpoint is not replaced
by a normal-stop checkpoint.

The original page-local preservation baseline is never reset. Its settings and
Device Identity comparisons remain applicable; its pre-work authorization
high-water comparison may correctly be false after a real authorization. The
separate recovery checkpoint verifies persistence of the actual authorized
advance. This changes no controller wire protocol, firmware outcome or authority.
