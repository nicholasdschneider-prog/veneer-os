# Dedicated purchase timing verifier — v1

Build #406 implements a native, independently authenticated service contract. It does not implement or activate an OrderOps consumer, enroll a source, import an approval, or place a purchase. The timing exception can replace only the source's greater-than-seven-day delivery block; every other purchasing condition remains a source obligation.

## Identity and legitimate setup

Use a **new**, dedicated Cloudflare Access service application/audience and client, routed only to `/api/purchase-timing/verifier/*`. Configure `VP_PURCHASE_TIMING_CF_AUD` and `VP_PURCHASE_TIMING_CLIENT_ID` on the native installation through its existing protected configuration process. These are nonsecret identity identifiers; the service token secret remains solely with the actual source custodian. Never put credentials into the setup form, proposal, chat, report or request body.

The resolver requires production Cloudflare identity, configured team issuer, RS256 verification, exact dedicated audience, and exact service `common_name`. Any `email` claim is rejected. A human session, bot token, local dev identity, or Return/Routine/AutoShip/candidate credential is not accepted. Audience/client collisions with those configured services disable this verifier. This service identity is not attached to a users row and does not inherit human or bot API access.

Before enrollment, the original source custodian must provide verified nonsecret source origin, account ID, source principal ID, actual deployment revision, custody/mapping receipt, and the existing native business/executor. The custody receipt documents setup evidence; **it is not purchase approval proof**. The current business owner must review that mapping in the existing authenticated workspace at `/#/purchase-timing-setup`. Full workspace access is required; a restricted employee or a bot cannot enroll. No impersonation or borrowed session is permitted.

Human API (ordinary existing authentication; never service authentication):

| Method and path | Request / result |
|---|---|
| `GET /api/purchase-timing/setup` | Current configuration availability and this human's owned businesses/eligible existing executors. |
| `POST /api/purchase-timing/setup/review` | `timingEnrollmentSchema`; read-only exact normalized enrollment, review hash, ready/registered/revoked status and any existing nonsecret receipt. |
| `POST /api/purchase-timing/setup/confirm` | Strict `{enrollment: timingEnrollmentSchema, review_hash: string, confirm: true}`. Revalidates owner, configuration, executor and exact review hash before immutable enrollment. |
| `GET /api/purchase-timing/setup/registrations/:request_key` | Read-only same-key registration receipt after uncertainty. A missing record is not confirmation. |
| `POST /api/purchase-timing/setup/trusts/:trust_id/revoke` | Strict `{reason: string}` (1–1000 trimmed characters); actual current owner only. Revocation blocks new proof and execution checks, but historical claims remain reconcilable without execution. |

Enrollment fields are all required: `request_key`, `business_id`, `executor_id`, `source_origin`, `account_id`, `principal_id`, `source_deployment`, `custody_receipt`. Dedicated audience/client and owner identity are supplied by the server, never by the request. Registration keys and payloads are immutable. A conflicting key or business/account/executor registration is refused; revocation cannot be undone here. Keep the original key if a confirmation response is lost. The UI switches to GET reconciliation and does not submit again.

The nonsecret receipt includes schema version, trust ID, stable request key, owner/business/executor, account/principal/origin, dedicated audience/client, creation time and revocation status. Registration proves only native setup. Source configuration and independent consumer acceptance are still required. No actual enrollment receipt was created by this build.

## Strict service wire contract

Base path: `/api/purchase-timing/verifier`. All JSON bodies are strict: unknown fields fail. Requests are bounded to 256 KB. Responses use `Cache-Control: no-store`. No equivalent MCP verification, claim or enrollment tool is exposed to bots. `raise_decision`/`update_decision` can carry a structured `purchase_timing` proposal, but cannot mint source captures or trust.

The exact generated JSON schemas are in [contract-schemas.json](./reports/purchase-timing/contract-schemas.json), with runtime refinements in [purchaseTimingSchema.ts](../server/src/bots/purchaseTimingSchema.ts). Date/identity/order/uniqueness/freshness/state checks below remain mandatory in addition to JSON Schema validation.

| Method and path | Request schema | Success schema / semantics |
|---|---|---|
| `POST /captures` | `timingCaptureSchema` | `timingCaptureResponseSchema`: retained capture ID, source-scope hash, `execute:false`. This is authenticated source evidence, not approval. |
| `GET /trusts/:trust_id/captures/:request_key` | Exact path keys, no body | Same capture response, read-only reconciliation. |
| `POST /verify` | `timingRequestSchema` | `timingVerifyResponseSchema`: current exact native proof, `execute:false`. This performs no claim or execution. |
| `POST /claims` | `timingRequestSchema` | `timingClaimResponseSchema`: first durable claim only returns `execute:true`, `reconciliation_only:false`; identical retries return `execute:false`, `reconciliation_only:true`. |
| `GET /trusts/:trust_id/claims/:request_key` | Exact original trust/intent keys, no body | Historical claim receipt, `execute:false`, `reconciliation_only:true`. Never a fresh applicability assertion. |
| `POST /execution-checks` | Strict `{schema_version:"veneer-purchase-timing-execution-check/v1", trust_id, request_key, source_capture_id}` | `timingExecutionResponseSchema`: read-only `applicable:true`, **`execute:false`**, same claim ID and original nonrenewable expiry. Requires all current native/source checks. It cannot recover a lost first execution grant. |

Verification and final execution checks use one native transaction so authority, scope and revocation are checked consistently. They write no business or claim records. Every service operation independently checks the dedicated identity and its exact trust association. Current operations also check owner, registered executor/business and revocation. Historical reconciliation can remain available after business revocation; it grants no execution.

### Authoritative source capture

`timingCaptureSchema` requires `schema_version:"veneer-purchase-timing-capture/v1"`, enrolled `trust_id`, stable capture `request_key`, UTC ISO `captured_at`, and complete `scope`.

The scope requires:

- `schema_version:"orderops-purchase-timing-material/v1"` plus exact enrolled `business_id`, `account_id`, canonical HTTPS `source_origin` (no trailing slash), `principal_id`, and native `executor_id`.
- Distinct source `order_id`, display `order_number`, `shopify_order_id`, and a nonempty `lines` array. Every line has exact `order_line_id`, `shopify_line_id`, `sku`, positive safe-integer `quantity`. Both line ID namespaces must be unique; lines are sorted ascending by `order_line_id` without normalization or trimming.
- Positive safe-integer `amount_cents`, uppercase three-letter `currency`, exact original and checkout delivery windows `{start,end}` in real `YYYY-MM-DD` dates, and an IANA `timezone`. Window start cannot exceed end. The comparison is calendar days between window ends, not elapsed DST hours. This verifier covers delays exceeding seven days only.
- Existing source `source_action_id`, `source_proposal_version`, `material_version`, `cart_version`, and lowercase SHA-256 `material_fingerprint`. These must come from the authoritative source under its own existing authentication and locks. The new consumer must define and verify their mapping to its existing records; a worker/operator receipt or bot assertion cannot substitute.
- UTC ISO `authorization_expires_at`, strictly in the future and at most 24 hours away at capture. This expiry is part of the approved exact scope and cannot be extended by refreshing evidence.

Capture time must be no more than 30 seconds old or one second in the future. Claims and verification require a fresh capture and native receipt, each within 30 seconds. Newer authenticated material for the same trust/order with a different scope hash supersedes older material, even if an earlier capture is still within its time window. Source captures are immutable; identical-key readback does not refresh their age.

### Native proposal and the three hash namespaces

For **new, legitimately sourced scope**, the original owning bot includes this exact additional field in the ordinary native proposal before human review:

```json
{
  "purchase_timing": {
    "schema_version": "veneer-purchase-timing-proposal/v1",
    "capture_id": "actual-retained-source-capture-id",
    "scope": "the complete structured scope object described above"
  }
}
```

The `scope` above denotes an object, not a literal string. Native raise/revise validates that the capture already exists, matches byte-for-byte canonical scope, belongs to the exact owner/business/executor and is not revoked. New/materially changed timing scope needs fresh capture evidence. Existing live prose-only decisions are unsupported; this release does not authorize retrofitting them or soliciting duplicate business approval to bypass that limitation.

Canonical JSON recursively sorts object keys lexicographically, preserves array order, uses compact JSON with UTF-8 encoding, and hashes with SHA-256 lowercase hex. Numbers are bounded integers in source scope; strings are not normalized. Compare each namespace only with its own authoritative counterpart:

1. `native_proposal_hash`: hash of the **complete stored native proposal**, including defaults and all evidence, presentation, scope and executor fields. This must equal the immutable proposal snapshot actually answered by the human.
2. `source_scope_hash`: native-computed canonical hash of the complete source scope DTO. Both the originally approved capture and the fresh authenticated capture must equal it.
3. `source_material_fingerprint`: source-owned digest, accompanied by `source_material_schema`. It is not the native proposal hash or the scope hash. The source consumer must bind it to its actual material records and existing versions; Veneer does not reconstruct its authority from prose.

No string equality between unrelated hash namespaces is inferred. A hash, local binding predicate, `list_decisions` JSON, `inspection_hash`, setup receipt, or source observation alone is not native human approval proof. Proof is returned only over the dedicated authenticated verifier response after all native checks.

### Native approval verification

`timingRequestSchema` requires `schema_version:"veneer-purchase-timing-request/v1"`, `trust_id`, stable source-intent `request_key`, `decision_id`, positive `decision_version`, exact `native_proposal_hash`, and fresh `source_capture_id`.

The decision must belong to the enrolled original executor and be on the exact current version in **running** state. Needs-input, rejected, deferred, blocked, superseded and terminal states cannot qualify. The service requires one immutable `answered` event with `actor_conversation_id:null`; a bot using the same numeric human owner ID is not a human answer. Its action must be approve, scope this_case, and exact text/actor must agree with the current native answer. The actual human must remain active, eligible to answer, and able to access the current evidence. The original approved snapshot must hash identically. The original answer wake must be delivered, and the latest native result must be running with `material_evidence_unchanged:true`.

New structured timing answers capture a server-owned human-context watermark inside the answer transaction. A later human direct message, result reply or decision discussion invalidates proof conservatively; bot follow-up does not. Missing watermark is unsupported, not a reason to backfill one. Human approval expires at the scope's explicit expiry or after 24 hours, whichever comes first. Runtime source checks remain required even if native proof is current.

## Source execution protocol and UNKNOWN handling

The original OrderOps owner must implement and independently validate this sequence. Native deployment alone is not consumer acceptance.

1. Under existing exact order/action locks, reconcile the existing action and durable intent. An unknown prior purchase/submit remains reconciliation-only. Check all current payment, stock, hold, duplicate, customer, destination, cart, executor and other business guards. Never create a replacement job or clear an attempt.
2. Persist the stable source intent **before** calling `/claims`. Bind its native decision/version/hash and source material/action/cart/version scope. Retain the exact capture and request. A read-only `/verify` may explain eligibility but never authorizes execution.
3. Call `/claims` only for this existing intent. A single first success can return `execute:true`. Claims are permanently unique by native decision and by business/account/source order, including across executor/trust replacement. Conflicting keys or scope are refused. The response's expiry is at most **five seconds** after native verification and is nonrenewable.
4. While retaining source order/action locks, call `/execution-checks` with this same claim and a fresh unchanged authoritative capture, then compare source material and all local gates again after the network response. The original `execute:true` must have been received unambiguously in this execution attempt; final applicability is **not** a substitute for it. Check the original expiry using a trustworthy synchronized clock immediately before the external boundary. If freshness, locks, response schema or applicability is uncertain, do not submit.
5. Perform at most the one authorized source effect using the existing source idempotency/duplicate protocol. After a timeout or unknown provider outcome, preserve the same action/intent and use existing read-only source reconciliation. Do not call a second purchase, replace an intent, or request another native grant.

A lost `/claims` response is **UNKNOWN**, even if GET confirms that a claim exists. GET and identical claim retries always return `execute:false`. Execution checks cannot renew the window or grant a second permission. A 404 during reconciliation is not permission to retry an external effect. No endpoint resets claims or acknowledges a purchase as completed; source receipt/delivery truth remains with OrderOps.

This is not a distributed transaction between native state and the source provider. The source's final locked check is the last verification boundary; a later native change cannot undo an external effect. Keep the interval bounded by the original five-second expiry, use no cached approval, and document this boundary in consumer acceptance. Native revocation, newer human input or material drift before that check is denied. No external lock is claimed by the native server.

## Failure semantics

Errors contain `schema_version:"veneer-purchase-timing-error/v1"`, `code`, `error`, `execute:false`. Treat unknown codes, malformed responses, redirects, timeouts and transport errors as deny/UNKNOWN, never approval.

- HTTP 400 `INVALID_FIELDS`: strict request/schema violation; no authority.
- HTTP 401 `IDENTITY_REJECTED`: missing/invalid dedicated JWT or disabled configuration.
- HTTP 403 `IDENTITY_REJECTED`, `OWNER_REQUIRED`, `ACCESS_REVOKED`, or `NATIVE_ACCESS_OR_STATE`: wrong caller or revoked native access.
- HTTP 404 `NOT_FOUND` or native access error: exact object not found/accessible; does not prove no source effect.
- HTTP 409: `REQUEST_CONFLICT`, `ALREADY_CLAIMED`, `SETUP_CONFLICT`, `SETUP_CHANGED`, `TRUST_REVOKED`, `EXECUTOR_REVOKED`, `SOURCE_BINDING_CHANGED`, `SOURCE_SUPERSEDED`, `SOURCE_STALE`, `NATIVE_BINDING_CHANGED`, `HUMAN_ANSWER_REQUIRED`, `HUMAN_CONTEXT_CHANGED`, `NOT_APPROVED_RUNNING`, `STRUCTURED_SCOPE_REQUIRED`, `UNSUPPORTED_SCOPE`, `EXPIRED`, or `NATIVE_ACCESS_OR_STATE`. Preserve scope and original intent; do not turn these into a duplicate approval flow.
- HTTP 413 `INVALID_FIELDS`: body exceeds limit. HTTP 405 `METHOD_NOT_ALLOWED`: unsupported operation.
- HTTP 503 `SETUP_REQUIRED`: legitimate separate configuration is incomplete. HTTP 500 `INTERNAL_UNKNOWN`: reconcile the original stable intent read-only; a response failure can occur after a durable claim.

## Current reference case and deployment limits

The commissioning evidence for native decision `353b6bff-eb83-48fc-b3c8-93907e9b8ba6` v1 remains needs_input/unapproved and lacks this structured source-capture approval contract. No current live record was queried or changed during implementation. It cannot qualify based on the historical human result reply alone. Sage retains sole custody; Platform Dev neither imports consent nor purchases. The greater-than-seven-day hold stays until genuine authority, dedicated trust and independently accepted source integration exist. Do not retrofit the live proposal, invent mappings, or ask for a duplicate approval click as a workaround.

Actual outstanding setup: dedicated Cloudflare Access application/client and native configuration, verified source deployment/custody mapping from the original source operator, genuine owner enrollment, then consumer integration/acceptance under source locks. No source registration, credential reuse, customer effect or operational purchase test was performed.
