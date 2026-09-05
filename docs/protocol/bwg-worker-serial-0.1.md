# Worker Serial 0.1 and Controller 0.4

## Canonical manifest

The manifest is this exact object (canonical JSON sorts object keys recursively):

```json
{"profile":"bwg-worker-serial/0.1","transport":"esp32s3_usb_serial_jtag","baudRate":115200,"framing":"utf8_ndjson","maximumControlPayloadBytes":65536,"maximumWireFrameBytes":66560,"heartbeatIntervalMilliseconds":1000,"heartbeatTimeoutMilliseconds":2800,"foregroundOnly":true}
```

`serialManifestSha256` is base64url without padding of SHA-256 over UTF-8 canonical JSON. VID/PID and port labels do not establish runtime identity. No application USB descriptor claim remains.

## Stream envelope

Every protocol line is one UTF-8 JSON object terminated by one LF. Literal CR and LF are forbidden before that terminator; escaped JSON string sequences remain valid. Each envelope has exactly `profile`, `kind`, `sessionId`, `sequence`, and `payload`. `profile` is `bwg-worker-serial/0.1`. `kind` is `session`, `control`, `heartbeat`, or `diagnostic`. `payload` is an object. The complete line is at most 66,560 bytes including LF; a control payload is at most 65,536 UTF-8 JSON bytes. Incremental parsing must bound partial frames and never interpret diagnostic/log text as commands.

The host hello uses `sessionId:null`, `sequence:0`, `kind:session`, and payload `{op:"hello",hostNonce:<32 random bytes as 43-character base64url>}`. The device replaces/revokes any previous session and answers `sequence:0`, `kind:session`, with its new 128-bit random `sessionId` encoded as 22-character base64url. Ack payload is exactly `{op:"hello_ack",hostNonce,deviceNonce,serialManifest,firmwareSourceCommit,appElfSha256}`. `deviceNonce` is 32 fresh random bytes encoded as 43-character base64url. Source commit is 40 lowercase hexadecimal characters; ELF digest is 64 lowercase hexadecimal characters.

After hello/ack, each direction starts at sequence 1 and strictly increases across all frame kinds without reuse or wrap. Gaps are permitted for discarded low-priority diagnostics; out-of-order/repeated values are invalid. No other frame may use a null session ID. The session ID is a fresh local transport binding, never a durable device identity or backend field.

Heartbeat payload is exactly `{}`. A valid current-session, advancing incoming heartbeat refreshes the peer deadline. Other incoming traffic, outgoing success, queued but unprocessed bytes, and repeated/stale heartbeats do not. Send every 1000 ms, revoke at 2800 ms. Heartbeat/protocol owners must not wait for Work Lease execution or large diagnostic writes.

A close payload is `{op:"close",reason:<closed Worker restoration reason>}` in a session envelope. Controller request IDs use the `serial_` prefix and remain at most 128 characters. Control payloads are bounded request/response object shapes specialized to Controller 0.4, or possession 0.2 requests/responses. Diagnostic payloads use `{line:<bounded producer marker>}`. Only the exact startup, memory, boot/reset, code-identity, allocation-context and panic marker grammars are eligible for a local qualification view; adapters parse them into closed categories, bounded numbers, closed enums, and public code digests. Arbitrary log text, extra fields, credentials, network identity, Device Identity, and request payloads are discarded. The same closed startup markers may be recognized while resynchronizing pre-session text. These observations never establish admission or liveness and are never submitted to the backend or included in public controller status.

## Signed possession

Request is `{profile:"bwg-worker-possession/0.2",requestId,command:"prove_possession",payload}`. Payload contains exactly `purpose`, `possessionNonce`, `challengeBindingSha256`, `controllerCapabilitySha256`, `sessionId`, `hostNonce`, `deviceNonce`, and `serialManifestSha256`. Purpose remains `initial_admission` or `transport_reacquisition`. Nonce and digest encodings retain their exact 32-byte base64url bounds.

Signed claims contain those exact payload fields plus `profile:"bwg-worker-possession-proof/0.2"`, `firmwareSourceCommit`, `appElfSha256`, and the strict Ed25519 `deviceIdentityJwk`. Response correlation, one-shot verification, expected Device Identity continuity, optional exact package expectations, and no-proof-persistence rules remain mandatory. The JWS protected type remains `bwg-worker-possession+jws`; the signed profile enforces version separation.

The authorization context hashes canonical `{profile:"bwg-worker-control-session/0.2",request,response}` using the existing exact verified-transcript algorithm. Only the resulting `controlSessionBindingSha256` can reach the Authority. New foreground sessions require fresh proof; no active lease survives session loss.

## Signed capability and Work Lease authority

Capability protocol is `bwg-worker-controller/0.4`; `board.usbTransport` is `web_serial`; `transportProfile` is `bwg-worker-serial/0.1`. Attestation claims are exactly `profile:"bwg-reference-firmware-capability/0.2"`, `protocolVersion`, `board:{model,revision}`, `firmware`, `compatibility`, `transportProfile`, and `serialManifestSha256`. Protected type remains `bwg-worker-capability+jws`.

Public trust profile becomes `bwg-worker-deployment-trust/0.2`. Update audience is `bwg-reference-firmware-capability/0.2`; Work Lease audience is `bwg-worker-controller/0.4`. Work Lease authorization profile becomes `bwg-worker-lease-authorization/0.2`. Preserve the exact compact claim shape `operation`, `requestSha256`, `controlSessionBindingSha256`, `sequence`, its 512-byte bound, complete-input canonical digest, and durable per-key monotonic sequence checks. Header type remains `bwg-worker-lease-authorization+jws`. Existing private keys need no automatic rotation and sequence state must not reset during migration.

## Bounded acceptance campaign

Controller 0.4 Start optionally carries `acceptanceCampaign:{id,window,maximumActiveMilliseconds}`. ID is one 128-bit base64url token, window is integer 0, 1, or 2, and its maximum is exactly 180000, 30000, or 30000 ms respectively. This entire object is included in the full-input Work Lease signature. Renew cannot change it. The task-gated firmware acceptance mode durably pre-reserves each full window without refunds or resets on reconnect; cumulative reserved active time is at most 240000 ms. Normal production remains outside that explicit mode.

Close has no acknowledgment. A normal host first confirms Controller Restore, then sends Close best-effort and releases the serial reader/writer/port. On foreground loss it revokes local command admission immediately; device heartbeat expiry remains authoritative even if browser cleanup cannot finish. Initial challenge/storage preparation precedes Hello; the local capability and possession exchange must finish within 2800 ms, then send the first heartbeat immediately. Diagnostic payload may be `{line:<one producer-allowlisted metadata marker>}`; the browser discards it and never exposes arbitrary device text.

## Qualification-only probe and device evidence

After possession and while no Work Lease is active, `transport_probe` accepts exactly `{padding:<ASCII x repeated zero or more times>, responsePaddingBytes:<integer>}` and returns `{padding:<ASCII x repeated to the requested response length>}` as `result`. The requested response length must be at least the input padding length and must leave room for the exact Controller response envelope. No arbitrary input is echoed. Both complete Controller payloads must fit 65,536 bytes. The qualification helper independently fills the request and response bounds using their exact request ID, so both directions reach exactly 65,536 bytes. The probe has no mining, NVS, or configuration effect.

Status optionally carries `qualification` with exact schema `worker-qualification-v1`. It is read-only evidence, never admission authority. Fields `generation`, `active_ms`, `generation_elapsed_ms`, `submitted`, `accepted`, `rejected`, `nonce_work_correlations`, `work_dispatched`, and `last_valid_heartbeat_ms` are u32. Active time begins with first successfully transmitted ASIC work and runs through confirmed reset-low or power-off, including the ordered shutdown ramp. Generation elapsed time includes preparation and freezes at confirmed halt. `gate_closed_ms` and `shutdown_started_ms` are nullable u32 timestamps; bounded comparisons use wrapping subtraction. `budget_reserved_ms` is 0–240000 and `budget_complete` is boolean; campaign IDs are never exposed.

`safe_stop_stage` is exactly one of `not_started`, `stop_dispatch`, `reduce_frequency_and_reset_nonce`, `hold_reset_low`, `disable_core_voltage`, `disable_asic`, `fan_full`, `cooling_proof`, or `fan_paused`. `safe_stop_complete` is boolean. `voltage_volts`, `power_watts`, and `chip_temp_celsius` are nullable finite numbers; `fan_rpm` is nullable u16. `voltage_fresh`, `power_fresh`, `temperature_fresh`, and `fan_fresh` are boolean and true iff the corresponding numeric value exists and its device sample age is at most 1000 ms. `watchdog_alive` and `mine_on_boot` are boolean. Before the first admitted generation, qualification is absent. The last generation remains observable after an idle reconnect until the next Start.

## Local acceptance page

After building from a verified Gate commit with `bun run build:browser`, serve through the existing repository development server and open `conformance/bwg-worker-serial-0.1/acceptance.html`. The build embeds its actual Git source commit; configuration contains exactly that `expectedGateCommit`, `expectedFirmwareSourceCommit`, `expectedAppElfSha256`, and public `trust`. The challenge and retention bound are minted only after the human permission chooser resolves. No local helper owns USB: the Connect button calls the production `navigator.serial.requestPort` adapter directly.

`window.workerAcceptance` exposes `configure`, `connect`, `prepareStartAuthorization`, `loadWindow`, `loadSignedWindow`, `startWindow`, `refresh`, `probe`, `stop`, `close`, `suppressHeartbeats`, and `state`. Only public configuration may be read from a file. Private signed windows pass through stdin/stdout and one-time loopback responses in memory; they are never written as files. `prepareStartAuthorization` exposes only the context digest permitted for the local Work Lease Authority. `loadWindow` requires `{grant,renewals}` with a signed acceptance campaign; private Stratum fields and authorization artifacts are retained only in page memory. `state()` contains only closed status, source identity, bounded probe counts, and validated qualification evidence.

Heartbeat suppression is available only in the task-gated acceptance page after a campaign window has started. It only stops sending heartbeats; it cannot extend a lease or grant control. Hardware commands remain subject to the firmware repository's approved exact-package task and acceptance budget.

## Protected local supervisor and streaming signing

The qualification page automatically reads public `GET /context` without opening USB or starting a credential lifetime. After the permission chooser has actually granted a port, it calls `POST /activate` with `{}` and receives exactly `{challengeId,retentionExpiryUnixSeconds}`. Only then does it open the port and send Hello. Human chooser wait is unbounded; no challenge, credential, or heartbeat deadline runs during that wait.

`prepareStartAuthorization` posts only `{controlSessionBindingSha256}` to `/authorization-context`. `loadSignedWindow` consumes the one-time `GET /window-artifacts` response with no-store caching and a bounded body reader. No private window file input remains. Supervisor records receive only `workerAcceptance.state()` and a window ordinal; raw grants, pool settings, signatures, and campaign/session identifiers never enter that state.

The local authority CLI supports `sign-start` and `sign-renew` with `--input - --output -`: one bounded stdin JSON input and exactly one stdout artifact JSON. No raw input is persisted or printed. Private authority and monotonic sequence files remain protected and durable. `public-trust --directory <protected-directory> --output -` exports only current public role keys without rotating keys or resetting replay state. Firmware may merge those public entries with retained deployment keys; conformance fixture keys are never implicitly substituted for deployment authority.

Graceful Pause/Restore may await cooled baseline confirmation for up to 145 seconds, independently of the three-second shutdown-initiation budget. Heartbeats continue while that graceful wait remains foreground. Hiding or losing ownership immediately stops heartbeats, aborts the pending wait, and releases the port; device-local safe stop continues and a later fresh session must independently confirm completion.

## Private preservation and winning revocation attribution

Status may independently include `preservation` before mining. Its exact wire object is `{schema:"worker-preservation-v1",settings_sha256,authorization_high_water_sha256,device_identity_sha256,mine_on_boot}`. The three digests are lowercase hexadecimal SHA-256 values; `mine_on_boot` is boolean. Settings cover explicitly nonsecret hardware/UI preferences only. Wi-Fi, pool/network, hostname, swarm, and scoreboard values are excluded even from hashes. Device identity uses SHA-256 of the raw verified Ed25519 public key, never its seed.

The browser checks that the reported Device Identity digest equals the digest of its freshly verified possession key. Raw preservation fields are stripped from public Controller and headless status. The qualification page retains the first preservation snapshot in a private closure and exposes only `{schema:"worker-preservation-continuity-v1",baseline_id,settings_match,authorization_high_water_match,device_identity_match,mine_on_boot}`. The 128-bit base64url `baseline_id` is unpredictable and minted once with that page's first admitted snapshot; it is unrelated to the device. A refreshed page creates a new baseline ID and cannot silently continue the previous twenty-cycle lineage. No raw Device Identity/settings/replay digest is posted or stored.

All twenty pre-mining cycles require the same baseline ID, all three comparisons true, and mining disabled. Legitimate signed mining advances authorization high-water state afterward; later mining windows retain device/settings continuity and baseline lineage without pretending that replay state did not advance.

Every present qualification object additionally has required `revocation_reason`: `none`, `heartbeat_timeout`, `lease_or_budget_expired`, `restoration_requested`, `unsafe_observation`, `link_closed`, or `control_failed`. `none` means no revocation has won. The first winning reason remains bound to that started generation's timestamps across idle reconnect. Reason attribution never extends a lease or changes shutdown behavior.

Qualification window termination explicitly requests `restore("cancelled")` and waits for its confirmed baseline response. Ordinary SDK Pause remains a separate resumable intent. This expresses the required ordered terminal shutdown and cooling policy without relying on an incidental firmware mapping of Pause.

The normal acceptance window requests terminal Restore when fresh `work_gate_remaining_ms <= 2000`, leaving a margin before the device stops dispatch; that deadline already reserves the complete ordered shutdown tail. Browser elapsed time remains a fallback, never an extension. Public `renewalsConfirmed` is reset for each successful Start and increments only after a validated signed renewal acknowledgment; normal acceptance requires at least one. There is no invented 175-second minimum. Lack of an accepted share within the fixed budget remains an explicitly unverified criterion and never extends work.

The acceptance page also uses RAM-only challenge continuity storage; qualification never opens IndexedDB or persists the canonical Device Identity fingerprint. Normal non-qualification SDK challenge-retention behavior is separate.

Qualification includes required `active_limit_ms` (nullable u32; 180000/30000 for acceptance windows, null for unlimited normal operation), `shutdown_budget_ms` (u32; current derived bound 15550), and `work_gate_remaining_ms` (nullable u32; null before first dispatch or when unlimited, zero after revocation). The device arms the active budget at first dispatch and reserves the shutdown tail inside that same allowance. The 180/30/30 limits include hashing during ramp-down; stopping order is not shortened.

Before intentionally hiding the page in window 1, call `armForegroundLoss()` to refresh device evidence and require more than 3000 ms of work-gate headroom. Window 2 heartbeat suppression performs the same fresh check. Automatic visibility-loss fail-safe handling remains unconditional. Missing or exhausted headroom rejects a planned fault instead of racing the budget deadline.

Public acceptance `deviceRestorationConfirmed` and `deviceLeaseInactive` reflect the latest validated Controller status, including internal graceful Close acknowledgments. They are invalidated on a new connection, an issued state-changing command, or ownership loss. Local `running:false` and hardware `safe_stop_complete` cannot substitute for these device confirmations; final window/cleanup verdicts require both. The outer graceful-response bound is 145 seconds for the derived 138550 ms terminal sequence plus transport allowance; cooling remains 120 seconds and heartbeat revocation remains 2.8 seconds.

## Peer liveness and diagnostic failures

Both peers emit advancing session-bound heartbeats at one-second intervals. Device output owns one sequence across heartbeats, control responses, and diagnostics; periodic heartbeats take priority over queued control and diagnostic records. Device heartbeats preserve browser link observation only. They never authenticate a browser, extend its signed Work Lease, or replace advancing authenticated browser heartbeats at firmware admission boundaries.

The qualification page preserves its current admission stage across asynchronous transport closure and records only a closed failure category. A stream failure and actual port closure are separate outcomes: the failure remains visible, while confirmed native closure releases origin ownership. A pending native close retains ownership even after the bounded caller returns.

Network startup observations use the exact `wifi_startup_failure` producer grammar with closed phase/error categories. These observations remain local and non-authoritative; raw exception text and network inputs are never projected.

Large records remain indivisible JSON lines. The browser refreshes its authenticated heartbeat before a maximum probe, and firmware sends a peer heartbeat before a long control reply. Each write and final drain share a two-second record budget; neither this budget nor extra peer traffic extends the 2.8-second authority cutoff. A closed `usb_tx_failure` diagnostic can report write/flush stage, elapsed milliseconds, bytes queued to the driver, and record size. Queued bytes are not proof of delivery. No record contents or session identifiers appear in this diagnostic.
