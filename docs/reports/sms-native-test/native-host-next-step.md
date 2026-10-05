# Minimum native fixture host on this Mac

October 5, 2026. Proposed implementation scope; not installed or accepted.

## Verified receipt

Build #577 staged preparation is commit `029a783`; #578 diagnostic evidence is
`77734c6`; permanent role-training design is `35b8e11`. The previous 52 focused
checks passed (21 preparation, 31 guide). They establish neither native
execution nor isolation. This planning turn runs no new software validation.
All native scenarios and latency measurements remain unrun/null. No production
restart, deployment, provider session or customer effect occurred.

Fresh read-only observations: this machine is arm64, macOS 27.0.1 (26A434),
with Swift in the installed Command Line Tools. Neither `tart` nor `limactl`
was found on PATH. Existing #578 evidence shows restrictive Seatbelt bootstrap
profiles aborting; permissive controls are not an accepted boundary. A Swift
binary's presence does not prove a signed VM helper can boot here.

## Chosen MVP: local Linux arm64 VM, Codex first

Implement a small signed Swift host using Apple's Virtualization.framework,
a pinned Linux arm64 image, and virtio socket communication. Apple documents
Linux VMs and virtual socket devices on this platform. This makes a local VM
a supported engineering approach, not a verified ready-to-use installation.
Use no host directory shares, clipboard, USB devices, host keychain, host
credentials, shared browser sockets or general host-network attachment.
Do not install a daemon or modify production launchd services. Run the staged
helper explicitly as a test artifact after its local isolation checks pass.

Start with one guest and one native Codex app-server identity. A supervisor
serializes commands and admits up to 1/3/5 independent native sessions within
that guest; histories are separate and workers are capacity. Proposed initial
guest limits are 4 vCPUs, 6 GiB RAM, 16 GiB disk and ten customer sessions.
These are configurable bounds, not measured capacity. Low host capacity queues
or blocks fixture work; it never evicts ordinary bots.

A trusted guest supervisor owns provider authentication and native app-server
stdio. Untrusted fixture tools run as a different guest UID with a scrubbed
environment, private mounts and network/process restrictions. Native built-in
shell, browser, arbitrary file and shared MCP surfaces must be denied by an
enforced provider-process policy, not simply removed from the visible tool
list. Prototype a Linux seccomp policy denying non-thread process creation and
subsequent exec, paired with exact runtime filesystem restrictions and a
protected native credential store. Verify native startup/thread operation and
all built-in tool paths against the selected CLI version. If app-server needs
an incompatible helper or can expose its protected identity through any built-in
path, this design fails acceptance; keep `/start` closed and revise enforcement.
The native executable is trusted to authenticate, but no model-driven tool may
read credentials or inherit its privileges. A different UID alone is not proof.

Guest communication uses dedicated, size-bounded framed virtio socket channels
for supervisor control, fixture RPC and provider egress. No general socket proxy
or host shell endpoint exists. The host egress mediator allows only the pinned
provider's observed authentication/inference protocol; reject private/loopback
destinations, arbitrary CONNECT targets, redirect destination drift and raw DNS
bypasses. The guest has no alternate network device. Test actual native protocol
compatibility and TLS validation before accepting this path. A generic HTTPS
proxy plus an allowlist alone does not prove these requirements.

## Source interfaces to implement under existing test-only authorization

1. A staged VM helper and reproducible guest-image builder with image/helper/CLI
   digests, hypervisor entitlement, no-sharing configuration validation, resource
   bounds, explicit start/stop and no production service installation. Use a
   pinned official Linux image and verified packages; retain nonsecret build
   provenance. The precise signing entitlement and successful guest boot are
   local implementation checks, not tasks for Nick to design.
2. A separate fixture supervisor adapter, never the ordinary shared-home adapter:
   `prepareHost`, `inspectHost`, `startNativeSession`, `submitTurn`, `stopRun`,
   `reconcileIntent`. Every call binds owner/run/session, guest generation,
   provider/model and image/profile/training digests. Missing or stale evidence
   denies admission. No host-provided credential payload is accepted.
3. A fixture-only RPC service with bounded schemas for synthetic order reads,
   proposals, durable local SMS intents and sink reconciliation. Enforce exact
   run/customer/order/material revisions, cutoff and cancellation/refund gates.
   Store intent before dispatch; lost association or sink responses stay UNKNOWN
   and do not free an effect key. Do not expose live connectors or ERVP APIs.
4. A role snapshot publisher/materializer binding permanent training-chat
   provenance, approved version and content digest. Each run pins one shared
   playbook; each native session gets only its synthetic customer history.
   Missing or mismatched snapshots block. Corrections create scoped guidance and
   synthetic regression examples through the authorized training skill workflow;
   in-flight runs retain their version and business rights never expand.
5. An observed event collector and read-only monitor: durable session association,
   actual queue/startup/turn/tool/reply/readback/sink events, compatible clocks,
   failed/unanswered totals, age and p50/p95/max, duplicates, wrong-order effects,
   escalations and unsupported success claims. Never retain secret headers,
   device codes, hidden reasoning or real customer records. Cross-clock latency
   stays null without offset evidence; sink acceptance is not carrier delivery.

Keep current unconditional `/start` denial until a dedicated acceptance record
binds every implemented boundary above. Preparation v1's requested hashes are
not that record. No ordinary bot/account enrollment or production changes are
part of this staged implementation.

## One unavoidable external prerequisite

After engineering and pre-auth isolation acceptance, an authorized human must
complete a fresh native ChatGPT device sign-in **inside the dedicated guest
identity**, with device login enabled for their account/workspace. No shared
credential copy, secret export, API-key substitution or automated impersonation.
Use native device authentication and a protected owner-only enrollment surface;
never put its one-time code in reports/logs. Bind the successful nonsecret
provider identity receipt to the guest/profile generation. Verify chosen CLI
credential-store support inside this guest before showing enrollment.

This is the one human-dependent prerequisite. The host, transport, policy,
training binding and evidence collector are substantial unfinished engineering,
not further human decisions or existing accepted capabilities. Current scope
expressly excludes human enrollment, so prepare and verify the enrollment path
first, then request only that concrete technical setup. Do not ask Nick to
design isolation or repeat customer-send consent. If device login is unavailable,
report that exact account restriction; no credential-copy fallback is authorized.

## Bounded acceptance before native experiments

- Boot the pinned guest without provider auth; prove no host mounts/credentials,
  business sockets or network route. Use synthetic forbidden-access canaries,
  not real secrets. Verify descendants, UID separation, private mounts, process
  execution restrictions and rejection of forged supervisor/RPC requests.
- Exercise egress against a controlled protocol test peer: forbidden hosts,
  DNS/private-IP/redirect bypasses and arbitrary tunnel attempts fail; valid
  protocol succeeds without recording payload secrets. This is infrastructure
  testing, never native runtime evidence.
- Prove manifest/snapshot mismatch denial, cross-customer history separation,
  same-version materialization for every admission, and no permission expansion
  after a natural training correction.
- After authorized guest sign-in, start one real native session, one synthetic
  inbound and one fixture read/local sink operation. Require authenticated
  lineage and actual substantive reply/readback; inspect native forbidden-tool
  attempts. Kill between intent and response and verify durable UNKNOWN without
  replay. STOP prevents new admission and preserves reconciliation.
- Only then run the 15 scenarios and requested five repetitions of 1/5/10
  customers by 1/3/5 admissions, including cold/warm/busy-owner/failure/429/cutoff
  races. Record all failures and unanswered turns. No estimated fixture timings.

## References

- [Apple Virtualization.framework](https://developer.apple.com/documentation/virtualization)
  and [Linux VM example](https://developer.apple.com/documentation/virtualization/creating-and-running-a-linux-virtual-machine)
  support the proposed platform approach, not this unimplemented host's security.
- [Apple virtual socket configuration](https://developer.apple.com/documentation/virtualization/vzvirtiosocketdeviceconfiguration)
  documents the proposed guest communication device.
- [Official Codex authentication](https://learn.chatgpt.com/docs/auth)
  documents headless device login and protected credential-store options. Account
  availability and selected CLI compatibility still require verification.

See [prior probes and blockers](./build578/report.md) and
[staged interface and permanent training design](../../sms-native-fixture-tests.md).
