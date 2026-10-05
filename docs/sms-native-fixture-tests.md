# SMS native fixture tests — staged preparation, not executable

October 5, 2026, build #577. This change is **not a completed native fixture-run
mode**. No native provider was started, no business integration was installed,
and no customer-experience acceptance or native latency result exists.

## Implemented boundary

The authenticated API mounts `/api/fixture-tests` after the existing native
identity, active-user, employee and focused-workspace boundaries. Only a human
installation owner may use it. Owner-backed agent tokens are also denied. This
is a preparation ledger, not enrollment of a source, provider identity or bot.

Data is lazy-created in a separate `DATA_DIR/fixture-tests/preparation.sqlite`,
outside the business database, only after a permitted ledger operation. The
directory has mode 0700 and database mode 0600. No migration changes the business
schema. There is no reference to the conversation manager, shared materializer,
provider adapter, Doppler, memory, browser, shell or transport in the ledger.
The code cannot start any model: `/start` unconditionally returns HTTP 503.
Neither a request flag nor a profile hash can enable it.

Manifests bind the authenticated owner's ID, stable request key, requested
provider/model, fixture/training/profile hashes, unique synthetic customer and
session bindings and order lists. Hashes describe **requested, unverified**
material; they do not attest that training or an isolated profile exists.
The manifest bytes, hash and provenance are immutable. SQLite triggers prevent
application-level UPDATE/DELETE; an administrator with filesystem/database
access can still alter the file. Per-run event hash chains detect ordinary
tampering but are not external signatures or OS isolation attestations.

Input receipts persist before the admission-blocked event, in one immediate
SQLite transaction with FULL synchronous durability. Identical input retries
return the same receipt, including after stop, expiry or reopening. Payload or
scope drift fails. There is no retry executor or replacement effect key.
The preparation API accepts only explicit synthetic IDs and a synthetic-only
attestation. Text is untrusted fixture data; these checks cannot identify all
private data inside arbitrary text. Do not paste actual customer information.
No text is executed, passed to a model or stored in customer memory.

Admission requests are limited to 1/3/5, manifests to 1–10 distinct customers,
turns to 1–30 per customer and budgets to 1–600 seconds. At most ten unstopped
preparations may exist per owner. These are preparation limits, **not measured
worker admissions**. Budget expiry and stop prevent new input; immutable old
receipts remain reconcilable. Stop never evicts or interrupts other chats.

## Supported staged HTTP contract

All paths below start with `/api/fixture-tests`. These routes are not installed
in the running product by this build.

| Method/path | Result |
| --- | --- |
| GET `/readiness` | `ready:false`, `execute:false`, four concrete blockers |
| POST `/runs` | `{requestKey,manifest}` → immutable `PREPARED_BLOCKED` record |
| GET `/runs/:id` | Owner-bound record and requested manifest |
| POST `/runs/:id/inputs` | Durable synthetic receipt; `BLOCKED`, `NOT_QUEUED` |
| POST `/runs/:id/start` | Always 503; no normal-chat/direct-provider fallback |
| POST `/runs/:id/stop` | Idempotent STOPPED preparation; no replay |
| GET `/runs/:id/trace?after=0` | At most 500 immutable events plus pagination cursor |
| GET `/runs/:id/monitor` | Read-only preparation timeline, blocked/unanswered totals and age |

Manifest schema is `veneer-fixture-manifest/v1`. Required fields: `syntheticOnly:
true`, `provider` (`codex` or `claude`), `model`, three lowercase SHA256 hashes
(`fixtureHash`, `trainingHash`, `profileHash`), `admissions`, `maxTurns`,
`wallTimeMs`, `sessions:[{sessionId,customerId,orderIds}]`. IDs start with
`fixture-`; bindings cannot overlap across sessions. Inputs contain
`sessionId,customerId,orderId,messageId,syntheticOnly:true,text`.
Unexpected fields are rejected, including credential/profile-ready fields.

Actual preparation traces contain run/session/customer/order/message/turn IDs
where applicable, requested profile/training/manifest hashes, a process clock
ID, monotonic nanoseconds, UTC, sequence and event hashes. Only preparation
registration, inbound capture, blocked admission and stop events can be written.
There is no public telemetry-ingestion endpoint that could fabricate native
startup, model output or tool success. Read-only monitoring makes missing native
reply/effect/escalation/sink/provider/carrier observations null. Failed,
timed-out and UNKNOWN native turn counts are zero because **no native turns
exist**; blocked and unanswered counts are displayed separately. Do not interpret
these zeros as a successful benchmark. Percentiles have zero observations and
null p50/p95/max. There is no browser monitoring UI or native trace ingestion yet.

## Exact prerequisites for executable native tests

1. Implement and independently exercise an enforced native process host for
   this Mac. Deny access to both login and service homes, keychain, business data,
   inherited environment, shared IPC/browser/terminal sockets and other process
   capabilities. A workspace sandbox or artificial HOME alone does not suffice.
   A separate OS principal or VM boundary must cover the provider process and
   descendants, not merely commands the model invokes. Prove forbidden file,
   credential, socket, subprocess and descendant-process attempts fail before
   allowing any model start.
2. Implement approved native subscription authentication inside that boundary.
   Current adapters pin shared CODEX_HOME/CLAUDE_CONFIG_DIR and inherit the host
   environment. Do not copy a shared credential home, print/read/export a login
   secret, borrow a business identity or change a running bot's account. The
   accepted path must expose neither provider credentials nor business secrets
   to fixture tools or model-readable files. This build provides no such path.
3. Implement enforced egress mediation: only the chosen provider protocol and
   authenticated fixture transport may leave the process boundary. Deny all
   arbitrary destinations, loopback business APIs, DNS bypasses, redirects and
   children inheriting wider network permissions. A list of tools or prompt
   instruction is insufficient. No existing adapter supplies this enforcement.
4. Implement an authenticated native fixture-only tool transport and synthetic
   backend with order/customer/session ownership, atomic cutoff/readback fences,
   human-gated cancellation/refund proposals, STOP and durable sink intents.
   Do not import the offline Python responder as the agent or treat its Python
   audit hook as isolation of a native provider. No browser/shell/shared agents,
   connector discovery or memory surface may be reachable. Accept and pin the
   actual ERVP training material and profile, not just the supplied hashes.
5. Integrate the host into Veneer's native conversation lifecycle with durable
   native-session association and 1/3/5 actual admissions, session serialization,
   turn/time budgets and outcome reconciliation. Persist effect intent before
   tool dispatch; a lost start/tool/sink response must remain UNKNOWN. Restart,
   cutoff, STOP and timeout must not free the effect or allow another attempt.
   The current unconditional gate must be replaced only by this accepted,
   implemented boundary, not a configuration toggle or caller assertion.
6. Add authenticated observed queue/provider/model/tool/reply/readback/sink
   telemetry and a read-only timeline/health UI. Match actual provider/model and
   clock evidence; exclude hidden reasoning, secrets and unrelated data. Distinct
   clocks without offset evidence have null durations. Sink acceptance cannot
   establish carrier delivery. Check duplicates, wrong-order effects and
   unresolved escalations from observed state, not model claims.
7. Run the 15 ERVP native scenarios and five repetitions of all 1/5/10-customer ×
   1/3/5-admission combinations, including multi-turn warm/cold/busy-owner bursts,
   failure/429, cutoff races and STOP/UNKNOWN. Record every unanswered/failed turn
   alongside percentiles. Unit preparation matrices are not this experiment.

The remaining blockers are architectural implementation/acceptance work, not
missing customer approval. Deployment alone will **not** make this build runnable.
To inspect the preparation API in production later, a separately authorized
installation must first pass Node 24 typecheck, full tests and build, then follow
the normal `npm run restart` procedure. No restart, deployment, launchd change,
source enrollment or human impersonation was authorized or performed here.
Local automated tests use throwaway ledgers and loopback test servers only.

The current CS training/autonomy boundaries remain authoritative. Cancellation
and refund require their existing human approvals. The proposed hour window is
inactive. AutoShip SMS remains paused. Nothing changes ERVP source, customer
messaging, vendor submissions, postage, finance or production orders.
