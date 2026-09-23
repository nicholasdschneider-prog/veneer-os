# CS draft follow-through — BUILD275

## Presentation, not authority

Only existing `nonexclusive_bot_queues` entries still belonging to ERVP business `5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86`, with active bot registration, receive `cs_lifecycle` on draft DTOs. Existing read ACLs remain. CS human `send` mutation rejects; ordinary human draft behavior outside this lane remains. No state migration or automatic retirement occurs.

`list_message_drafts` includes `approved_obligations` drawn only from current same-business structured `message_delivery.executor_conversation_id` bindings, after normal decision-read ACL. This does not associate those approvals with ordinary drafts. William’s ordinary draft differs materially from his approved message and remains unbound. His original approval is not withdrawn. No refund is replayed.

Unbound does not mean routine-authorized. A missing standing policy, source verifier, unsupported category, or legacy approval proof remains a technical dependency, not a request for a second per-email human approval. Actual unanswered bound decisions link to the existing central question. Queue, claim and receipt states remain distinct.

## Native/source routine interface amendment

Existing source owner: `a4bc7b0c-e56a-4b90-b4bc-cb71cbc88e68`, BUILD276. Existing native owner: Platform Dev, BUILD275. Separate dedicated routine service identity/trust required; return credentials confer no routine authority.

### Complete native context

Dedicated authenticated `POST /api/routine-message/verifier/native-context`:

```json
{"trust_id":"actual-trust","canonical_case":"exact-source-case"}
```

Returns business/account/executor/principal/canonical_case, `coverage:"complete-native-business/v1"`, `revision` SHA-256, `ready`, `execute:false`, `blocking_count`, `reason`. No private proposal text is returned. The digest includes every decision in that native business, its version/state/proposal/answer/result and latest immutable event row revision, plus the exact requested binding. It does not rely on assigned-handler visibility or bot-supplied decision lists.

**Conservative limitation:** any native decision not `verified_completed` blocks. Legacy records lack authoritative case/account scope; even unrelated unresolved records block. Neither OO nor a bot may silently exclude them or mark them completed to unblock this path. This is complete conservative business coverage, not exact-case clearance. Narrower exclusions require a separately established authoritative binding contract.

Every capture now requires `native_context_revision` from that endpoint. The native service recalculates it inside capture, acceptance, bot claim and service dispatch transactions. A new decision, revision, result or discussion invalidates stale coverage. SQLite write transactions serialize native mutation against claim/dispatch; no source assertion of `human_directive:none` replaces this check. Source holds, pending effects and own leases remain independently enforced.

### Two-stage claim, no forwarded authority

1. Source persists a durable intent before any dispatch request.
2. Named bot accepts an exact native template and calls `claim_routine_message` with a separate fresh proof. This now reserves only: `execute:false`, `source_dispatch_required:true`. It is not permission for a bot/provider send.
3. Dedicated source service calls `POST /api/routine-message/verifier/dispatch-claims`:

```json
{
  "draft_id":"exact-draft", "claim_key":"reserved-native-key",
  "proof_id":"fresh-claim-proof", "source_intent":"already-persisted-source-intent",
  "scope_hash":"64hex", "material_hash":"64hex", "request_key":"stable-association-key"
}
```

Native verifies its stored claim/proof/intent, current trust/policy/executor, exact payload, <=15-second proof, >=30-second lease and fresh unchanged native context. It atomically records an immutable one-time association **before** responding. Only the first response contains `execute:true`, with exact request fields, trust/policy/account/principal/executor/source origin/scope and `veneer-message:<draft_id>` idempotency key. Source must compare every binding against its durable intent and serialize its own current material/hold/lease/enrollment/duplicate checks before creating one outbox effect.

Identical replay returns `execute:false`; changed binding fails. Lost first response is UNKNOWN, not permission to dispatch. `GET /drafts/:id` returns exact claim, proof, scope/material hashes, source intent, association and any readback, always `execute:false`. Do not send from reconciliation. Changed material after reservation is blocked, not remapped automatically. A source unable to prove the original permitted response was durably associated must retain manual uncertain custody.

Trusted SENT readback additionally requires a service dispatch association; no bot may fabricate a receipt. Revocation does not erase historical evidence. These changes do not enable factual tracking or other unsupported categories.

## Remaining transport and setup

BUILD276 owns complete source material/hold/media ambiguity evaluation, revision fencing including new/sister messages, durable intent/outbox and exact SENT readback. Source reported no typed reviewed missing-field evidence yet; empty columns/category labels are insufficient. Dedicated routine CF service, protected runtime keys, reviewed adapter digest, truthful routine account/principal registration and genuine owner policy/trust enrollment remain required. No production routine adapter/config/enrollment is claimed by BUILD275.

BUILD250 message UUID/ticket equivalence remains unsupported: default OO case GET is broad authenticated source data, not a dedicated native-caller/account/own-principal attestation. Required source projection is exact persisted case ID/ticket/customer/revision under a separately registered least-privilege source identity with account/business/executor/principal provenance and fresh revocation. No source reader custody has been established; no Avery bearer or return identity may be borrowed. Original source owner retains this boundary. The equality guard remains; no arbitrary unequal identifiers are accepted.

Legacy EXACT DRAFT approvals without immutable structured delivery scope remain non-importable. Neither this presentation nor routine claim changes retrofit PAU8K9/QH828K approvals or authorize their refund replays. Grant independently accepts configured delivery, then the original named executor obtains a real provider receipt. No live acceptance occurred in this build.
