# Protected native auth and exact egress package — staged

Build 581 implements a runnable **synthetic-only TLS mediation proxy**, durable
one-attempt wire intents, and a socket-restricted native pre-auth host. It changes
both native homes to supported ephemeral credential storage and explicitly denies
their auth.json files. It does not implement accepted live provider authentication
or inference. No sign-in, refresh, thread, turn, installation or restart occurred.
The fixture /start gate remains unconditionally closed.

## Supported native interface selected

The pinned official native Codex 0.145.0 executable and public runtime inventory
remain fixed by codex.py. The selected future interface is native-managed
account/login/start with type chatgptDeviceCode, in a **single trusted ephemeral
app-server process**. That same process manages refresh; tokens are not exported
to another native worker, a helper, an environment variable or a file. The
model-driven fixture tool process remains independent and receives only private
scoped synthetic tool capabilities, never native identity material. Native
external-token injection remains prohibited.

The official [authentication documentation](https://learn.chatgpt.com/docs/auth)
supports device auth, ephemeral storage and CODEX_CA_CERTIFICATE for corporate
TLS mediation, including HTTPS and secure WebSockets. Installed public source
[ephemeral storage](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/login/src/auth/storage.rs)
uses a process-local map keyed by CODEX_HOME, distinct from the file and keyring
backends. Native initialization independently confirms effective ephemeral
configuration and account:null. This proves pre-auth configuration, not live
device-flow or refresh behavior. Process death loses that local identity; no
automatic re-login, token copying or stored refresh replay is permitted.

The fixed public proxy environment contains HTTP_PROXY/HTTPS_PROXY/ALL_PROXY
pointing to one IPv4 loopback gateway, empty NO_PROXY, and a private public CA
file. HOME/CODEX_HOME/TMPDIR stay private; no credentials enter environment or
stdio test receipts. The native environment/proxy profile successfully performs
initialize, account/read(refreshToken:false) and config/read. No auth or inference
request was made by native Codex. Actual auth/inference compatibility stays null.

## Runnable mediation and enforced controls

Run from this checkout, without installation or an account:

```sh
python3 scripts/fixture-host/egress_test.py --receipt /private/tmp/new-egress-receipt.json
python3 scripts/fixture-host/codex_test.py --receipt /private/tmp/new-native-receipt.json -v
```

Each receipt path must be new. Prerequisites are macOS arm64, Python standard
library, Xcode clang, system OpenSSL, and the already pinned public Codex CLI.
No dependency installation, OS account, service or UID change is needed to run
these synthetic controls. Synthetic certificates/private keys are generated only
in new private temporary directories and deleted; their values never enter
reports. The public certificate hash can enter evidence.

egress.py provides a real loopback CONNECT proxy with TLS termination and a
separate TLS-authenticated local synthetic upstream. It has **no public upstream
mode, arbitrary URL, DNS lookup, credential input, production enable flag or
owner sign-in API**. Its only upstream socket is fixed 127.0.0.1 at the trusted
synthetic listener port. No secret injection or direct provider client exists.

CONNECT accepts only auth.openai.com:443 and chatgpt.com:443 with the exact Host
header. SNI must match the CONNECT authority; the client verifies the ephemeral
CA/name and the upstream verifies its own synthetic CA/name. Alternate authority,
SNI, CA, port, proxy authorization, absolute URL, query, encoded/path variation,
HTTP method, additional header, transfer encoding, upgrade or redirect is denied.
An allowed route alone grants nothing: an exact authority/path/header/body wire
must match an independently authorized, expiring, private keyed intent. Forged
authorization headers and changed bodies fail. Header/body/credential bytes never
enter ledger rows, receipts or logs.

The closed source-informed routes are:

| Authority | POST path | Phase |
|---|---|---|
| auth.openai.com | /api/accounts/deviceauth/usercode | Device request |
| auth.openai.com | /api/accounts/deviceauth/token | Device poll |
| auth.openai.com | /oauth/token | Exchange/refresh |
| chatgpt.com | /backend-api/codex/responses | Responses |

Auth paths are from the pinned public
[device flow](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/login/src/device_code_auth.rs)
and [exchange](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/login/src/server.rs).
The [native provider base](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/model-provider-info/src/lib.rs)
informs the Responses route. This is an initial **denying** wire registry, not
a claim that all real native headers, refresh payloads, SSE or WebSocket requests
are supported. Synthetic fixture-prefixed bodies are the only authorizable
requests in this package; real device/refresh/inference payloads cannot be granted.

The trusted internal authorization call binds owner/setup/run/session/customer/
order plus pinned native executable/profile hashes. Changed customer or lineage
fails before dispatch. Admission caps both pending intents and concurrent proxy
handlers at five. Grants expire within 15 seconds and revocation drops all
pending grants. SQLite FULL synchronization durably reserves UNKNOWN **before**
the upstream attempt; immutable outcomes record synthetic acceptance/rejection.
Redirect, TLS error or cutoff remains UNKNOWN; 429 is rejected; neither can replay.
Reopening the ledger discards all in-memory grants and rejects changed durable
scope. These are trusted synthetic supervisor primitives, not an authenticated
real-owner enrollment API. Existing backend signed setup lineage also pins the
egress source; no model gets the private keyed grant registry.

Kernel checks observe successful connection to the selected proxy port and EPERM
for another ready TCP listener and UDP. That same profile retains EPERM for a
synthetic private key outside the native home, credential-file write, symlink,
Unix socket, fork and self/shell subprocess; FDs and environment remain scrubbed.
The original process-environment canary remains mandatory before native startup.
Abort or unavailable listeners would not count as enforced denial.

Seatbelt's address grammar accepts localhost:port rather than literal IPv4.
Consequently it is a loopback-port restriction, **not IPv4-only kernel filtering**.
The fixed IPv4 proxy endpoint plus TLS trust/authority supplies additional peer
identity. An alternate synthetic CA fails; no blanket outbound or DNS exception
exists. IPv6 same-port and real native DNS/redirect/CONNECT behavior still require
native acceptance; do not claim the pre-auth startup tested those paths.

## Exact remaining coupling and owner setup

PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED and AUTH_INFERENCE_EGRESS_UNACCEPTED
remain accurate. The missing engineering is a trusted owner-only private device
code transport, native-managed refresh lifecycle acceptance, and an exact native
wire authorization adapter. It must authorize independently of model-supplied
network input, bind authenticated owner/setup/native/profile/lineage, validate
real protocol fields without logging secrets, and prove the native client uses
only the accepted proxy, including denied DNS, redirects, IPv6 same-port,
WebSocket/CONNECT variants and builtin network attempts. The present synthetic
registry cannot be broadened merely because native startup succeeded.

The runnable package is reviewable now; **no owner action or sign-in is requested
yet**. After that engineering and separately authorized installation are accepted,
the exact owner action is supported device sign-in through the dedicated private
owner surface with device auth enabled in ChatGPT security/workspace settings.
Codes/tokens must stay in that owner surface, never root/bot reports. No shared
auth home, keyring, OS-principal impersonation or credential copy is an option.
No privileged OS/service installation has been staged as a proved fallback.

Actual dynamic native fixture tool coupling, permanent ordinary CS role-chat
training capture/readback, private customer histories, native admission/timeline,
15 scenarios and 1/5/10 native tests are separate later work. The native provider
startup/output/tool/answer/carrier measurements remain null. The local synthetic
TLS acceptance receipts do not prove native model success or carrier delivery.
