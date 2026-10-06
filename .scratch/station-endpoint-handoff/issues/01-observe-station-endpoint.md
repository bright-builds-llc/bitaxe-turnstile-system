# Observe a possession-bound station endpoint for HTTP evidence work

Type: task
Status: resolved

Requested by `bitaxe-esp-miner` `task-parity-ota002-www-hardware-verification`
on 2026-10-06. Since the firmware's fixed Serial/JTAG migration, the device's
station address is reported only over authenticated serial control, and a host
supervisor needs it for live OTAWWW (`OTA-002`) HTTP evidence.

- Add the `stationEndpointHandoff` configuration mode, exclusive with every
  other qualification mode and sticky for the page.
- Add `workerAcceptance.observeStationEndpoint()`: once per page, while
  connected and idle, prove fresh possession and return the
  `telemetry_cadence_endpoint` reply bound to that possession. The private
  result returns only to the caller and never enters public page state. It
  grants no lease, work, liveness or mining.

## Comments

Resolved with `web/worker-endpoint-page.ts` and its tests; `bun run verify`
passes.
