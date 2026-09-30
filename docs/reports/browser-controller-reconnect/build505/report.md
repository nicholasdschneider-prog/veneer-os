# BUILD505 — scoped automation-controller reconnect

Implementation is staged, not deployed. No runtime recovery, page navigation, Print, PDF export, hold extension, customer/provider action or service restart was performed. The original Miles incident remains unverified; stale controller versus print modal is unresolved.

## Supported interface

`veneer_browser.inspect_controller {}` is original-chat-owner-only and returns the authenticated existing clone/profile/source generation/runtime/process generation plus latest sanitized recovery audit. It checks manager status without an automation command, ticket rotation or copy lifecycle action. A missing process marker is not a verified running Chrome instance.

`veneer_browser.reconnect_controller` accepts only:

```json
{
  "clone_id": "exact existing UUID",
  "source_profile_id": "exact original UUID",
  "source_generation": 12,
  "runtime_id": "exact manager runtime ID",
  "process_generation": "64 lowercase hex characters from authenticated status",
  "request_key": "stable UUID"
}
```

The runtime ID names a working copy and is insufficient as process identity. The new native manager status includes a SHA-256 marker over its recorded PID and actual spawn timestamp, only after checking the current process command against the exact profile directory. An older manager or unsupported backend supplies no marker and cannot satisfy recovery. Native verifies the exact marker before and after disconnect; a replacement process under the same runtime ID fails closed.

Recovery uses the conversation command queue and the stable controller queue, rechecks active original owner and profile ownership, and writes an immediate-transaction immutable reservation before touching the controller. This is a technical recovery record, not business authority. Requests bind the exact tuple; conflicting keys or unresolved previous recovery cannot start another attempt. Identical replays read the audit without reconnecting.

The in-process pinned WSS-to-loopback bridge must already exist for the exact controller session. Recovery first revokes that bridge, closes its sockets/listener and rejects pending upgrade/forward callbacks. Only then does it ask the scoped CLI controller to close. No control ticket or URL is supplied to that shutdown command. The detached endpoint cannot carry a subsequent Browser.close or tab-close command. There is no fallback to remote stop, suspend, delete, start, reassignment or raw Chrome access. Missing bridge proof, shutdown error/timeout or retained controller PID-file generation produces UNKNOWN and blocks normal automation. The old generic close helper is not directly exposed as live-copy recovery.

Ticket and probe caches and tab/reference state are invalidated. A successful result is `execute:false`, `outcome:detached`, `reconnectPending:true`, `earlierOperation:UNKNOWN`, `retryPriorOperation:false`. It does not claim a new controller connection, page readiness or export. The original owner's next tabs/read obtains a fresh manager ticket. An immutable read requirement survives server restart; a successful original-owner snapshot adds `read_verified` without clearing UNKNOWN history. Before the original-owner snapshot, the live process marker is rechecked on every command and automatic start/adoption of a missing or replacement copy is forbidden. Automatic lost-copy command retry is disabled for this recovered copy. Earlier forwarded operations cannot be canceled or certified ineffective by disconnecting; they must not be replayed.

Migration 0142 appends a sanitized recovery audit with UPDATE/DELETE rejection triggers. It contains scope IDs, hashes, actor, outcome and timestamps, never page text, URLs, tickets, arguments, secret values or exception bodies. The builder did not run a live migration or restart; live migration state was not probed.

## Verification

Synthetic tests cover original owner versus foreign caller, exact source generation/runtime, unchanged clone records, command queue serialization and access revocation during the wait, changed Chrome process under a stable runtime ID, no stop/suspend/delete/start fallback, immutable audit, request replay, unresolved recovery, sanitized errors, fresh-ticket/read fencing, and retained UNKNOWN after successful read.

The offline TLS/WebSocket fixture keeps an independent preview connection and upstream server alive while severing the controller bridge. The shutdown stub cannot reconnect to its former endpoint; no CDP close/page command is transmitted. Shutdown failure leaves the session quarantined. The native manager's existing fake-Chrome process test verifies the process marker against its spawned process record. Fixtures are not an actual Miles recovery or proof of the live print-modal state.

Node 24 root typecheck passed; scoped tests passed 260/260. Final full root tests passed: installer 29, server 3,234 with five declared skips, web 963, browser-manager 49; total 4,275 passes. Full tests used two Vitest workers. Root build passed with the Vite large-chunk warning. Earlier successful runs were superseded by the final process/preservation guards; final source checks are recorded in [validation.json](/Users/archerclawdington/veneer-os/docs/reports/browser-controller-reconnect/build505/validation.json).

## Deployment blocker and accountable handoff

Loading the new server code/migration and the manager process-generation status requires a supported coordinated service deployment. This request explicitly forbids a broad/root restart while preserving the preview. No restart, hot-loading bypass, direct service-manager action, raw controller recovery or deployment claim is made. Activation requires a separately authorized preservation-safe deployment; an old in-memory bridge is not assumed to survive it. Missing bridge provenance remains a concrete runtime gate, not permission to retry Print or close the copy.

Boris owns incident coordination; original Miles alone owns the eventual scoped inspection and authorized receipt export. The supplied historical incident tuple is clone `2a82de9d-463f-4678-aa20-49ea735ba34f`, profile `d21f7d37-71ac-46d5-8ba7-cd0a424a8d3d`, generation 12, controller session `vp-veneer-dc7413740d441882`, diagnosed controller PID 23700. These are reference facts, not current process proof. The recorded hold event 20415 expires 2026-09-30T20:39:05.652Z; this build does not extend it or promise completion by that time.

Only after a supported successful recovery may original Miles list tabs/read, verify the visible July 10 Shopify order 6035776536728 confirmation for warranty 7158080, and perform the separately authorized PDF export. The builder did none of those actions.

[Changed-file index](/Users/archerclawdington/veneer-os/docs/reports/browser-controller-reconnect/build505/changed-files.md) · [Implementation digests](/Users/archerclawdington/veneer-os/docs/reports/browser-controller-reconnect/build505/implementation-digests.json)
