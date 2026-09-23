> Current interface amendment: [BUILD275 native-context and authenticated dispatch claim](../cs-draft-follow-through/contract.md). The bot claim now reserves with `execute:false`; the source service alone may obtain first dispatch permission. The historical flow below is superseded on those points.

# Standing routine message contract — BUILD261

This is the native completion of the BUILD232/252 contract. **It does not establish a deployed OrderOps source adapter, activate a category in production, enroll a live policy, or authorize any affected customer draft.** BUILD258's return credentials, trust, source account and transaction authority are separate. The existing source owner remains `a4bc7b0c-e56a-4b90-b4bc-cb71cbc88e68`; no competing source builder is created.

## Implemented boundary

Only `missing_information` has an executable native template contract. It permits a model number, product-label photo, or installation-area photo request that a trusted reviewed source adapter has established is genuinely missing **and needed for the current question**. The native subject is `Information needed for your question`; the body is built exclusively from the fixed enum in `server/src/bots/routineExecution.ts`. It contains no customer-authored interpolation, remedy promise, attachment, financial language or custom subject/body. This intentionally supports less than the full BUILD203 category. It does not authorize all missing-information requests.

Factual tracking, catalog answers, restatements and unused-return workflows remain disabled. Acknowledgment-only, resolved and no-contact cases cannot generate an extra email. All financial/remedy/exception gates remain. Merely enrolling a policy, coordinating a bot, possessing source credentials, or supplying a category string does not enable anything.

## Dedicated transport and owner enrollment

1. Source custodian implements and reviews **a separate routine adapter** covering the requirements below. Record its exact deployed artifact SHA-256 and truthful source-account / origin / native-executor / own-principal registration provenance. Do not reuse the new return-only source registration as routine authority. Agree a stable routine account boundary explicitly.
2. Authorized platform operator provisions a dedicated service-only Cloudflare Access application for `/api/routine-message/verifier/*`, with its own audience and service client. Store credentials only in the approved protected runtime destination. Configure native `VP_ROUTINE_VERIFIER_CF_AUD` and `VP_ROUTINE_VERIFIER_CLIENT_ID`. The server rejects human, AutoShip and return audience/client reuse. Configuration/restart follows the platform queue and required checks. BUILD261 does not provision or borrow any credential.
3. The genuine current native business owner first enrolls the bounded policy using existing `POST /api/bot-communication/routine-policies/enroll`. Enrollment is a new current authenticated action, never a fabricated historical signature.
4. The same genuinely authenticated owner calls `POST /api/bot-communication/routine-messages/trust` with:

```json
{
  "policy_id": "actual-current-policy-id",
  "executor_id": "actual-named-native-bot-id",
  "request_key": "stable-reviewed-registration-key",
  "client_id": "dedicated-routine-service-client-id",
  "audience": "dedicated-routine-CF-audience",
  "account_id": "explicitly-registered-routine-source-account",
  "principal_id": "own-authenticated-source-principal",
  "source_origin": "https://verified-source-origin.example",
  "registration_reference": "immutable source-custodian and owner registration provenance",
  "adapter_digest": "64-character-reviewed-deployed-adapter-sha256",
  "contract": "routine-missing-information/v1"
}
```

These are documentation placeholders, **not a prepared live enrollment payload**. Native policy verifies business and owner; the executor must be in its explicit category/executor set and current business. Enrollment is rejected until dedicated transport is configured. `POST /routine-messages/revoke` takes `trust_id` and `reason`. Existing policy revocation/supersession and owner/executor revocation block new acceptance/claims. No borrowed owner session or bot enrollment is supported.

## Trusted source capture

Dedicated service-authenticated `POST /api/routine-message/verifier/captures` accepts only `routineCaptureSchema` in `server/src/bots/routineExecution.ts`. No bot-facing tool can submit this capture. Unknown fields, generic `eligible=true`, free-form message bodies and unsupported categories are rejected.

The deployed adapter—not a bot prompt—must obtain and verify:

- Its current own named principal, active enrollment/revocation and retained case ownership; unassigned does not mean unowned. No forwarded/borrowed bot bearer. Its own exclusive canonical-case lease must have at least 30 seconds remaining.
- Exact persisted canonical case, ticket, customer and source-account/recipient relation; all channels and sister conversations and all relevant inbound/outbound events. Use a bounded consistent snapshot with a revision fence, complete pagination, no truncation, and a final no-next-page sentinel. Exceeding the 100-conversation / 10,000-message bound is a disabled result, not permission to omit data.
- Explicit holds/reject/defer/withdraw from **both native and source authority**, ongoing unresolved exception duties, no-contact/ack-only status, duplicate requests and any pending/unknown earlier delivery. A generic source status or list of messages alone does not establish these facts. If native-to-source hold coverage cannot be established, do not publish a capture.
- Actually missing information across the complete text, image/attachment and earlier-answer context, not merely empty structured columns. If semantic or attachment context cannot be reliably evaluated, `uncertain` denies execution. The fixed enum is not itself eligibility proof. Each field's evidence revision must match the full snapshot revision.
- A durable `source_intent` that identifies this exact information request across all retries and potential draft copies. `duplicate_scope_hashes` covers other sends/reservations; exclude only the same exact native intent under reconciliation. Never clear another intent or unknown effect.

The capture records immutable account/principal/origin, reviewed adapter digest, enrollment revision, lease revision/expiry, capture time, material facts, complete channel/case manifest, message count, canonical message/material hashes, exact requested enum fields and evidence states. It is stored as a separate later source proof; no historical approval or proposal is changed. Freshness is at most 15 seconds, with at most five seconds clock skew. The source must reject before capture if any requirement is unavailable; an authenticated service is not permission to fabricate a completeness marker.

The adapter's source material hash manifest must include exact case/assignment/customer/recipient/sender linkage, native and source directions, all relevant channel/sister messages and attachment evidence, field evidence, prior outgoing intents and effects, and relevant source policy/version. Canonical object keys sort; arrays preserve order, so the source must sort unordered record sets deterministically by immutable IDs. Preserve actual source precision. Exclude only the same intent's internal reservation metadata and the separately freshly checked lease/enrollment renewal from the stable material hash. Document and review the actual source field manifest before activation. A source write that materially changes this context invalidates the claim path.

## Named executor acceptance and claim

Capture returns `proof_id`, exact `scope`, `scope_hash`, `material_hash`, and `execute:false`.

1. Named bot calls `inspect_routine_proof({proof_id})`; or `inspect_routine_message` with policy/category/exact scope and optional `proof_id`. Without source proof, existing inspection remains `ready:false`.
2. Save the returned payload verbatim through `save_message_draft`, then `accept_routine_message({proof_id,draft_id,expected_version,request_key})`. Only an own ordinary unapproved `draft` with no decision/delegation/claim is eligible. Existing case-approved or human-authorized drafts cannot be converted. The native transaction records separate immutable standing-policy authorization, keeps `authorized_by=NULL`, and queues the exact draft. No wake or automatic delivery occurs.
3. Source adapter freshly captures the same full material under a **new proof key**. Lease/enrollment may renew but material, scope and source intent must remain exact. Named bot calls `claim_routine_message({draft_id,proof_id,claim_key})`. The first valid claim atomically records the proof and moves `queued→sending`, returning `execute:true`, exact scope and `veneer-message:<draft_id>` idempotency key. Competing keys fail; identical replay returns `execute:false`. Retirement and claim serialize. No claim can follow retirement.
4. **Only the enrolled source dispatcher** may act on the first successful claim, with its own principal/lease and final local transactional material/hold/duplicate checks. Do not use old OrderOps POST or an arbitrary provider tool. Claim is the native authorization linearization point: revocation before it denies; revocation cannot undo an already dispatched effect. The source must durably bind the native claim and idempotency key to a single pending intent before any provider effect, preserve current local holds and source access, and ensure at most one outbox dispatch. A source unable to provide this dispatcher must stay disabled. A claim response lost before durable source association is **unknown**, not permission to claim again or dispatch from reconciliation.
5. Unknown outcomes use dedicated read-only `GET /api/routine-message/verifier/drafts/:id`. It always returns `execute:false`, even after revocation. It grants no permission to send or retry. Retain the original idempotency key and reconcile source/provider evidence; no new intent/key, scope replacement or automatic expiry into reusable authority. Existing `record_message_delivery` may mark a routine claim `uncertain`, but cannot assert `sent` or `failed`.

Native uniqueness covers draft, proof consumption, executor request key, source intent, and same trust/scope/material. It complements rather than replaces source/provider idempotency. Authorization audits and proof captures are immutable. Normal human drafts and exact-approved message delegation are unchanged.

## Verified delivery

Dedicated `POST /api/routine-message/verifier/readbacks` requires exact `draft_id`, `claim_key`, `scope_hash`, `material_hash`, `account_id`, `principal_id`, `idempotency_key`, `source_intent`, `provider_message_id`, current `verified_at`, literal `state:"SENT"`, literal `sent_count:1` and `payload_hash`.

The adapter must freshly read the actual source/provider SENT record and compare complete body, subject, sender account, recipient, canonical case, customer, ticket, attachments (empty here), source intent/idempotency and exactly one provider effect. An accepted/queued HTTP response, copied earlier receipt or search snippet is not readback. Native rejects mismatch, duplicate provider identity or conflicting receipt; identical stored receipt is idempotent even after its original verification time expires. It can record a verified historical effect after revocation, but that never grants new execution. No business case completion is implied.

## Concrete remaining dependency / ownership

Native producer: existing Platform Dev `732adce5-ea99-45d4-be9d-07ae47e02133`.

OrderOps source contract disposition: existing owner `a4bc7b0c-e56a-4b90-b4bc-cb71cbc88e68`, after its active BUILD258 return change. That owner explicitly reported no routine verifier established in the return paths it inspected; this is not a repository-wide absence claim. This release does not edit their source, create another builder or claim a queued source continuation receipt. Required source work is the complete capture/category evaluator, current own-principal/lease/native-hold binding, durable single-intent dispatcher and exact SENT readback above, plus reviewed field manifest and offline race tests. Then dedicated routine transport, source-account/principal registration, genuine owner policy/trust enrollment and independent acceptance are necessary.

Affected BGTJQK/WQ446A/QFCRLF and other incident records remain untouched. In particular factual tracking such as QFCRLF is **not enabled** by the missing-information template contract. No per-email duplicate human approval is offered as a workaround.
