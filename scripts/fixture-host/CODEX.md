# Staged Codex pre-auth fixture setup

This package implements callable native **pre-auth** bootstrap and an independent
synthetic stdio tool transport. It does not start native threads, turns, models,
login or authenticated provider sessions. The fixture /start gate stays
unconditionally closed. Nothing in this build was installed or restarted.

The selected public native CLI is codex-cli 0.145.0, SHA-256
1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590.
It is the native executable selected by the installed official npm wrapper,
invoked directly to avoid granting wrapper subprocesses. Inventory permits only
the observed System/usr-lib linked resources. Root-directory reads and exact
ancestor metadata resolve native bootstrap. Existing unreadable global
requirements cause rejection; metadata permission only handles absence.
Worker storage is ephemeral; dedicated auth storage is file-based in a separate
private home. No keyring, shared config, shared auth, env token or credential
copy is used. Effective configuration and account absence are verified over real
app-server RPC. Its 32 MiB file limit accommodates private SQLite startup;
the earlier 1 MiB limit produced SIGXFSZ and was a bootstrap failure.

Only initialize, unrefreshed account/read and config/read can cross the pre-auth
driver. Every other client RPC is rejected before transmission and any
server-initiated tool/approval request is declined. Kernel profiles deny network,
subprocess/fork and outside workspace files. This does not demonstrate actual
model builtin-tool behavior; no inference turn was started.

## Callable staged surfaces

After a separately authorized application installation, the **actual human
owner** can use /api/fixture-tests/codex-host. Agents, bot sessions and employees
are denied before any process or publication.

- POST /setup accepts only requestKey and boots fixed private worker/auth
  app-server instances before sign-in. It returns signed evidence, never readiness.
- POST /training accepts requestKey and snapshot {roleConversationId, version,
  syntheticOnly:true, bytes}. The native authenticated owner publication approves
  those exact synthetic bytes and records explicit publication provenance.
  roleConversationId is a desired role binding, not imported historical evidence.
- POST /runs accepts requestKey and coupling {setupId, snapshotId, sessions}.
  Each session has fixture-prefixed sessionId/customerId/orderId with no overlaps.
  Materialization binds actual CLI/launcher/profile/runtime hashes and the signed
  snapshot to independent native and peer homes. Each native pre-auth startup is
  measured; no customer/native conversation is created.
- GET /runs/:id reads signed owner-scoped material.
- POST /runs/:id/fixture-tools accepts sessionId, customerId, orderId, messageId,
  a closed tool name and exact tool arguments. It exercises the synthetic stdio
  peer, not a native model's tool call. Internal capabilities are minted/injected
  by the supervisor over private stdio; they are never returned or logged.
- POST /:setupId/device-sign-in/setup accepts an empty object and returns the
  supported device-flow method/parameters and dedicated home **with execute:false**.
  It starts no login and receives no secret input.

The closed tools are fixture.order.read, fixture.preference.set,
fixture.sms.accept, fixture.handoff, fixture.cancel.request and
fixture.refund.request. Preferences are durably projected/read back; sink
acceptance is a local immutable receipt with carrierDelivery:null; handoffs stay
unresolved; cancellation/refund remain HUMAN_APPROVAL_REQUIRED. AutoShip SMS
pause and proposed-hour inactivity remain unchanged.

Durable immutable intents precede every peer invocation. A missing/uncertain
outcome is UNKNOWN and cannot be executed again under the same message/action,
even after fixing material or reopening the database. Changed payloads conflict.
Missing snapshot, source/profile/training drift, owner/scope mismatch and
symlink/hardlink storage aliases fail closed. Every record/outcome carries a
server HMAC, with separate lineage/capability domains; keys never enter worker
directories, API output or logs. A stopped/failed materialization cannot replay
its setup intent. This is not the complete native queue/admission lifecycle.

The permanent ordinary CS role-chat capture/readback remains the intended shared
training workflow. This build provides exact synthetic publication/materialization
primitives, not that historical capture integration, new worker personas or
automatic business authority. Material reports permanentRoleChatCaptureVerified:false.

## Credential boundary finding and enforced repair

The prior broad sysctl policy allowed KERN_PROCARGS2 inspection of a deliberately
synthetic sibling's environment. Inherited-env/FD scrubbing and file denial from
build 579 did not cover that kernel interface. No real credential-bearing process
was targeted. The new profile uses only public hw.* and fixed uname/version
sysctls, permits self process-info, and explicitly denies others process-info.
The corresponding mandatory canary now returns EPERM and cannot observe the
synthetic marker; the broad-profile and unsandboxed controls observe it. Native
app-server initialize/account/config still work under that exact narrowed profile.
A version-only bootstrap was not used to establish full protocol compatibility.

Every setup compiles a fixed harmless probe, launches its own controlled synthetic
sibling, checks both the positive control and sandbox denial, and rejects the
setup if either observation is missing. This does not inspect any existing
credential process. An initially considered OS-principal fallback was withdrawn
after the narrow policy repair succeeded; no accounts or installer were run.

Worker ephemeral state, separate dedicated-auth file storage, outside-file and
process-environment denials establish pre-auth boundaries, not a completed native
credential bridge. protectedCredentialBoundaryReady remains false, with
PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED and AUTH_INFERENCE_EGRESS_UNACCEPTED.
Codex 0.145.0's locally generated external-token schema is explicitly marked
internal/unsupported, so it is not used as an auth bridge. No credential values
were read/copied or passed into an unaccepted native session.

Next engineering must implement an approved protected native auth/refresh bridge
and exact inference egress mediation, connect the fixture peer to actual dynamic
native tool requests, and bind the genuine permanent role-chat capture receipt.
Only after those concrete boundaries are accepted does the actual owner perform
supported device sign-in in the dedicated setup. Do not sign in yet or ask Nick
to select an architecture. No owner action is needed for this pre-auth milestone.
Actual inference, model tool round trips, 15 scenarios/concurrency, substantive
reply and monitoring acceptance remain pending; missing model/reply/carrier
timings are null.

## Reproduce pre-auth evidence

Development prerequisites: macOS arm64, Xcode clang/otool, Python standard
library, public Homebrew Node 24 and the pinned public Codex executable.

```sh
python3 scripts/fixture-host/codex.py --state /private/tmp/my-new-codex-preauth
python3 scripts/fixture-host/codex_test.py --receipt /private/tmp/my-new-preauth-receipt.json -v
```

State/receipt must be new and private; no command, native RPC, profile or
credential override is accepted. The receipt distinguishes successful pre-auth
protocol and synthetic transport from the repaired synthetic process-environment denial. Full native auth acceptance remains blocked.

Official references: [app-server protocol](https://learn.chatgpt.com/docs/app-server)
and [credential storage](https://learn.chatgpt.com/docs/auth). The installed schema
and actual bootstrap/configuration were checked independently; documentation
alone does not establish compatibility or protected credential acceptance.
