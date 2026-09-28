# Dedicated purchase timing verifier — v1

Build #406 implements a native, independently authenticated service contract. Build #408 closes its unimplemented execution boundary: no new claim or execution-check success is issued until an actual enforcing purchase transport exists. Existing claims remain read-only and cannot recover execution permission. It does not implement or activate an OrderOps consumer, enroll a source, import an approval, or place a purchase. The timing exception can replace only the source's greater-than-seven-day delivery block; every other purchasing condition remains a source obligation.

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
| `POST /claims` | `timingRequestSchema` | `timingClaimResponseSchema`: an existing identical claim returns only `execute:false`, `reconciliation_only:true`. A new otherwise eligible claim fails HTTP 409 `EXECUTION_BOUNDARY_UNAVAILABLE`, without inserting/consuming a claim. |
| `GET /trusts/:trust_id/claims/:request_key` | Exact original trust/intent keys, no body | Historical claim receipt, `execute:false`, `reconciliation_only:true`. Never a fresh applicability assertion. |
| `POST /execution-checks` | Strict `{schema_version:"veneer-purchase-timing-execution-check/v1", trust_id, request_key, source_capture_id}` | No success response is currently supported. After validating the existing claim and current state, returns HTTP 409 `EXECUTION_BOUNDARY_UNAVAILABLE`. Expiry/revocation/missing-claim denials may occur first. Never recovers a lost grant. The previous success schema remains documented only as the historical #406 shape. |

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

The `scope` above denotes an object, not a literal string. Native raise/revise validates that the capture already exists, matches byte-for-byte canonical scope, belongs to the exact owner/business/executor and is not revoked. New/materially changed timing scope needs fresh capture evidence. For an existing prose-only decision, the verifier checks its retained native human answer, unchanged proposal snapshot and current approver/evidence access before reporting `SOURCE_MAPPING_REQUIRED`. This is a source-linkage diagnostic, not a missing-consent diagnosis or an execution proof. No supplemental mapping is imported and no proposal is retrofitted.

Canonical JSON recursively sorts object keys lexicographically, preserves array order, uses compact JSON with UTF-8 encoding, and hashes with SHA-256 lowercase hex. Numbers are bounded integers in source scope; strings are not normalized. Compare each namespace only with its own authoritative counterpart:

1. `native_proposal_hash`: hash of the **complete stored native proposal**, including defaults and all evidence, presentation, scope and executor fields. This must equal the immutable proposal snapshot actually answered by the human.
2. `source_scope_hash`: native-computed canonical hash of the complete source scope DTO. Both the originally approved capture and the fresh authenticated capture must equal it.
3. `source_material_fingerprint`: source-owned digest, accompanied by `source_material_schema`. It is not the native proposal hash or the scope hash. The source consumer must bind it to its actual material records and existing versions; Veneer does not reconstruct its authority from prose.

No string equality between unrelated hash namespaces is inferred. A hash, local binding predicate, `list_decisions` JSON, `inspection_hash`, setup receipt, or source observation alone is not native human approval proof. Proof is returned only over the dedicated authenticated verifier response after all native checks.

### Native approval verification

`timingRequestSchema` requires `schema_version:"veneer-purchase-timing-request/v1"`, `trust_id`, stable source-intent `request_key`, `decision_id`, positive `decision_version`, exact `native_proposal_hash`, and fresh `source_capture_id`.

The decision must belong to the enrolled original executor and be on the exact current version in **running** state. Needs-input, rejected, deferred, blocked, superseded and terminal states cannot qualify. The service requires one immutable `answered` event with `actor_conversation_id:null`; a bot using the same numeric human owner ID is not a human answer. Its action must be approve, scope this_case, and exact text/actor must agree with the current native answer. The actual human must remain active, eligible to answer, and able to access the current evidence. The original approved snapshot must hash identically. The original answer wake must be delivered, and the latest native result must be running with `material_evidence_unchanged:true`.

New structured timing answers capture a server-owned human-context watermark inside the answer transaction. A later human direct message, result reply or decision discussion invalidates proof conservatively; bot follow-up does not. Missing watermark is unsupported, not a reason to backfill one. Proof eligibility ends at the scope's explicit expiry or after 24 hours, whichever comes first; the recorded human answer remains intact. Runtime source checks remain required even if native proof is current.

## Execution boundary closure and UNKNOWN handling

There is no supported purchase dispatch transport in the current native or inspected OrderOps implementation. OrderOps `transitionVendorOrderJob` checks source guards and commits `submitting` under its transaction locks. Sage subsequently clicks Place through a generic browser. Those locks have already ended. Native CDP and viewer controls do not mediate the actual purchase request, and a button-specific check would not prevent JavaScript, background or alternate-session submission. A five-second receipt does not solve this gap.

Accordingly **new claims are disabled in the service itself**, not merely hidden in a tool or UI. The server retains authentication, exact scope, approval and duplicate checks, then returns `EXECUTION_BOUNDARY_UNAVAILABLE` without creating a claim. No configuration flag, owner setup receipt, source assertion or bot input enables dispatch. `/execution-checks` likewise never returns success, including for a still-fresh historical claim. `/verify` remains strictly read-only and does not certify execution readiness.

Historical `/claims` replay and GET reconciliation keep the exact original request, claim ID and expiry and always return `execute:false`, `reconciliation_only:true`. Revocation or expiry cannot convert them into renewed permission. A conflicting key/scope remains a conflict; a new key for a previously claimed decision/order remains blocked. A missing record or provider-history absence is not permission to retry an effect. No claim reset, receipt import, automatic retry or purchase-completion endpoint is provided.

The original OrderOps owner reviewed and agreed to this closure and the concrete continuation design in coordination `c8873e9e-aed2-4abb-ae87-d44462618c74` at 2026-09-28T14:13:55Z. The [#408 investigation and acceptance plan](./reports/purchase-timing/build408.md) specifies the actual missing evidence, owners, source transaction ordering, durable pre-dispatch fence, browser egress requirements and acceptance matrix. This design is **not an implemented transport contract**. No guessed vendor endpoint, source-to-browser RPC or grant schema is advertised as available.

## Failure semantics

Errors contain `schema_version:"veneer-purchase-timing-error/v1"`, `code`, `error`, `execute:false`. Treat unknown codes, malformed responses, redirects, timeouts and transport errors as deny/UNKNOWN, never approval.

- HTTP 400 `INVALID_FIELDS`: strict request/schema violation; no authority.
- HTTP 401 `IDENTITY_REJECTED`: missing/invalid dedicated JWT or disabled configuration.
- HTTP 403 `IDENTITY_REJECTED`, `OWNER_REQUIRED`, `ACCESS_REVOKED`, or `NATIVE_ACCESS_OR_STATE`: wrong caller or revoked native access.
- HTTP 404 `NOT_FOUND` or native access error: exact object not found/accessible; does not prove no source effect.
- HTTP 409: `REQUEST_CONFLICT`, `ALREADY_CLAIMED`, `SETUP_CONFLICT`, `SETUP_CHANGED`, `TRUST_REVOKED`, `EXECUTOR_REVOKED`, `SOURCE_BINDING_CHANGED`, `SOURCE_SUPERSEDED`, `SOURCE_STALE`, `NATIVE_BINDING_CHANGED`, `HUMAN_ANSWER_REQUIRED`, `HUMAN_CONTEXT_CHANGED`, `NOT_APPROVED_RUNNING`, `SOURCE_MAPPING_REQUIRED`, `EXECUTION_BOUNDARY_UNAVAILABLE`, `UNSUPPORTED_SCOPE`, `EXPIRED`, or `NATIVE_ACCESS_OR_STATE`. Preserve scope and original intent; do not turn these into a duplicate approval flow.
- HTTP 413 `INVALID_FIELDS`: body exceeds limit. HTTP 405 `METHOD_NOT_ALLOWED`: unsupported operation.
- HTTP 503 `SETUP_REQUIRED`: legitimate separate configuration is incomplete. HTTP 500 `INTERNAL_UNKNOWN`: reconcile the original stable intent read-only; a response failure can occur after a durable claim.

## Current reference case and deployment limits

Sage's later owner-scoped acceptance reports native decision `353b6bff-eb83-48fc-b3c8-93907e9b8ba6` v1 approved at 2026-09-28T13:32:26Z, `action_pending`, with current/delivered version 1. Native conversational acceptance is complete; the earlier needs-input commissioning snapshot is stale. The exact approved case is #100121932, SKU643922 x1, $30.90 USD, October 5 versus the original September 25 window end, with Sage as sole executor.

That unchanged approval is retained as genuine native evidence. The compatibility gap is not a missing human yes. Native immutable conversational events retain source identity, full-context hashes and proposal binding; these are useful historical evidence, but do not prove source material facts. #408 validates the ordinary native answer before returning a precise source-mapping denial for prose-only scope. It does not backfill the separate #406 watermark or treat an inspection hash as source authority.

The source owner independently confirmed that retained reports do not establish the original source material/action/cart versions and fingerprint, the authenticated source-principal/account-to-Sage mapping, or complete historical quote/window lineage. Sage's checkpoint explicitly calls the original window mutable. A new observation cannot become a historical snapshot. Existing immutable source receipts, webhook/audit snapshots, original authenticated captures or vendor quote records could supply a supplemental mapping if their genuine provenance and exact linkage can be established. The source custodian owns locating that evidence; Nicholas is not asked to find it or approve again. Detailed field-level gaps and the concrete alternative are in the #408 report.

No live native record was read or changed here. Preserve original proposal/version/answer and Sage custody. No duplicate business approval, invented capture/version/watermark, source hash equality or customer/purchase effect is authorized. The >7-day hold remains until source evidence, dedicated trust and an actual enforcing transport are independently accepted.

Actual outstanding setup: dedicated Cloudflare Access application/client and native configuration, verified source deployment/custody mapping from the original source operator, genuine owner enrollment, then consumer integration/acceptance under source locks. No source registration, credential reuse, customer effect or operational purchase test was performed.
