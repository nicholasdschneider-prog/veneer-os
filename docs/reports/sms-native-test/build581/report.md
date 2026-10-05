# Build 581 — protected ephemeral setup and synthetic TLS mediation

This build stages executable TLS mediation and stronger native credential-file
boundaries. It does **not** complete accepted live native authentication, refresh
or inference. The runnable gateway is synthetic-only; it has no public provider
upstream or production toggle. No sign-in, model, customer effect, installation,
deployment or restart occurred. The fixture /start gate remains unconditionally
closed. Build #581 was verified running in the Veneer workspace before edits;
this chat was the sole editor and created no successor or handoff. ERVP source,
its protected commits, unrelated work and other bots were preserved.

## Implemented and observed

Both private native hosts now use supported ephemeral storage. The actual pinned
Codex 0.145.0 app-server initializes, returns account:null and verifies effective
ephemeral configuration. Its profile denies reading/writing its own auth.json,
including inside its private writable home. Synthetic C controls observe those
denials; sibling process-environment denial remains mandatory before startup.
No token/cache copying, shared auth home, keyring or unsupported external-token
API is used. Owner device setup returns ephemeral/no-file/native-managed-refresh
preparation facts, execute:false and unchanged auth/egress blockers. These facts
describe the selected supported lifecycle, not a live identity acceptance.

The [gateway source](/Users/archerclawdington/veneer-os/scripts/fixture-host/egress.py)
implements CONNECT termination, TLS identity/authority checks, a separate
authenticated local synthetic HTTPS upstream, a closed exact POST route table,
and independently keyed exact header/body wire authorization. Scope binds
owner/setup/run/session/customer/order/CLI/profile; altered scope, authority,
SNI, CA, header/body, route/query, additional headers, transfer encoding, upgrade
or redirect fails closed. Only synthetic fixture-prefixed bodies can be granted.
No network request API can mint a grant. Bodies, headers, capabilities, codes,
tokens and private keys are never logged or included in receipts.

The gateway caps pending grants and active connections at five. Expiry/revocation
drop pending grants. Immutable SQLite FULL-synchronized UNKNOWN intents precede
the single upstream attempt. Verified synthetic HTTPS response acceptance is
recorded separately; 429 stays rejected and redirect, invalid upstream TLS or
cutoff stays UNKNOWN. A consumed intent never replays. Reopening does not restore
grants and changed durable scope fails. These are synthetic trusted-supervisor
primitives, not owner enrollment or production authority. Existing backend signed
setup lineage additionally pins egress.py and rejects source drift.

The actual network-enabled kernel profile successfully connects to the selected
proxy port, while alternate ready TCP and UDP return EPERM. Under that profile,
synthetic outside key reads, own credential-file writes, CA writes, symlink,
Unix socket, fork and self/shell subprocesses remain EPERM; FDs/environment stay
scrubbed. The native process also successfully performs initialize/account-null/
config over stdio with the fixed public proxy and CA environment. No native auth,
refresh or inference request was sent through the gateway.

An initial literal IPv4 Seatbelt address rule failed to compile (exit 65), which
was not enforcement evidence. The accepted grammar is localhost:port. Thus the
kernel receipt proves a loopback-port boundary, not an IPv4-only filter. Fixed
IPv4 proxy configuration and TLS peer identity add a separate boundary; unrelated
synthetic CA and forged SNI are rejected. Real native DNS, IPv6 same-port,
redirect, CONNECT and WebSocket behavior remains unaccepted. No blanket network
or DNS permission was added.

## Raw results and limits

[Final synthetic acceptance](./acceptance-final.json) contains four successful
test cases, actual four-route HTTPS round trips, 429/cutoff/redirect outcomes,
kernel controls/denials, native startup/RPC/exit timestamps, public CA hash and
exact source/profile hashes. It explicitly reports nativeAuthAccepted:false,
nativeInferenceAccepted:false and no real sign-in or installation.
[Native boundary acceptance](./native-acceptance.json) contains five passing
native pre-auth/synthetic boundary tests with ephemeral config, own credential
file denial, scoped peer checks, process-environment canaries and descendant
diagnostics. Intermediate egress receipts are retained with their own source
hashes; only acceptance-final.json represents final egress source.

| Measurement | Result |
|---|---|
| Native initialize/account-null/config | Actually observed |
| Synthetic HTTPS routes | Four accepted; unapproved effects denied |
| Native device login / refresh | Not started; compatibility null |
| Native inference / dynamic tools / substantive reply | Not started; timings null |
| Carrier delivery | null |

Synthetic acceptance is neither native model success nor SMS/carrier delivery.
No native training, customer history, inference admission or monitoring result
is inferred from this package.

## Runnable setup and concrete remaining work

[AUTH_EGRESS.md](/Users/archerclawdington/veneer-os/scripts/fixture-host/AUTH_EGRESS.md)
documents the supported native selection, pinned public-source routes, exact
commands, files, resource policy, lifecycle and remaining compatibility checks.
The executable acceptance package needs the existing macOS arm64/Xcode/Python/
OpenSSL/pinned Codex resources; no new UID, service, dependency or privileged
installation is required for its local synthetic controls. Both
[CODEX.md](/Users/archerclawdington/veneer-os/scripts/fixture-host/CODEX.md) and the
employee/resumed-agent capability guide were updated accurately as staged.

The exact blockers remain PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED and
AUTH_INFERENCE_EGRESS_UNACCEPTED. Missing engineering is private human-owner
device-code transport, accepted native-managed refresh lifecycle, and the native
wire authorization adapter. It must independently bind real native protocol
requests to authenticated owner/setup/profile/lineage, never grant model-supplied
network inputs, validate actual header/body/SSE/WebSocket behavior without secret
logging, and verify denied bypass paths. The current synthetic registry refuses
real payloads, so it cannot be used to sign in or exercise models.

No owner action or architecture choice is requested. Only after that coupling
and separately authorized installation are accepted should the actual owner
perform dedicated supported device sign-in with device auth enabled in ChatGPT
security/workspace settings. Codes/tokens must remain in a private owner surface.
No privileged principal fallback is claimed or installed.

Later work remains actual dynamic fixture tools, genuine permanent ordinary CS
role-training capture/readback, pinned shared version with private histories,
native admission/timeline/UNKNOWN, 15 scenarios and 1/5/10 native customers.
Cancellation/refund human approval, AutoShip SMS pause and existing business
gates remain unchanged.

## Changed files

- [egress.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/egress.py)
- [egress_test.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/egress_test.py)
- [egress-socket-probe.c](/Users/archerclawdington/veneer-os/scripts/fixture-host/egress-socket-probe.c)
- [codex.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/codex.py)
- [codex_test.py](/Users/archerclawdington/veneer-os/scripts/fixture-host/codex_test.py)
- [codexSetup.ts](/Users/archerclawdington/veneer-os/server/src/fixtureTests/codexSetup.ts)
- [fixtureCodexSetup.test.ts](/Users/archerclawdington/veneer-os/server/test/fixtureCodexSetup.test.ts)
- [fixtureEgress.test.ts](/Users/archerclawdington/veneer-os/server/test/fixtureEgress.test.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- Package guides and this report/evidence folder linked above.

## Final validation

Typecheck, 57 scoped tests, the final full suite and build all passed (exit 0).
Full counts: installer 29, server 3,424 passed with 15 configured skips, web
1,008, browser-manager 51. The build retained Vite's existing large-chunk warning;
it exited successfully. No restart was run. The full suite was repeated after
final CA hardening; the initial log is historical evidence, not final-source
validation. [Build receipt](./build-receipt.json) binds actual source/evidence
hashes and checked outcomes without claiming native auth/model acceptance.

Evidence files:


- [acceptance-final.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/acceptance-final.json)
- [build-receipt.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/build-receipt.json)
- [build.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/build.log)
- [egress-acceptance-final.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/egress-acceptance-final.json)
- [egress-acceptance-verified.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/egress-acceptance-verified.json)
- [egress-acceptance.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/egress-acceptance.json)
- [full-tests-initial.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/full-tests-initial.log)
- [full-tests.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/full-tests.log)
- [native-acceptance.json](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/native-acceptance.json)
- [scoped-tests.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/scoped-tests.log)
- [typecheck-final.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/typecheck-final.log)
- [typecheck.log](/Users/archerclawdington/veneer-os/docs/reports/sms-native-test/build581/typecheck.log)
