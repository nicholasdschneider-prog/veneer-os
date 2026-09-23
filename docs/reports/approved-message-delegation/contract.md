# Approved-message owner/executor contract

Commission: `zcjal4-approved-nora-draft-bridge-20260923`. Build #229.

## Current case: stop at preflight

Read-only preflight of decision `5e78f3a2-f0c1-42df-a236-c3882a53c320` returned version 1, state `blocked`, original update time `2026-09-23 14:55:06`, and:

```json
{
  "ready": false,
  "missing_proof": [
    "proposal.message_delivery in the approved snapshot: exact channel/account/recipients/subject/body/customer/ticket/attachments, canonical_case and named executor; legacy EXACT DRAFT prose is not a structured transport authorization"
  ]
}
```

Nicholas’s native approval event `453ed642-5f81-4668-a0d8-adbf9574cdbb` remains intact. The approved snapshot has legacy `EXACT DRAFT` text and conversation evidence references. It does not contain the structured transport scope required by this bridge. This is **not** a claim that Nicholas changed or withdrew approval. Do not infer the account, recipient, attachments, or executor scope from prose, copy fields into an old approval, request duplicate approval automatically, create an ordinary unapproved draft as a workaround, or send directly around the bridge. No live delegation, acceptance, draft, send, decision update, customer/order update, or financial action was performed by the builder. The terminal $59.99 refund remains outside this work.

Grant owns this decision (`cb4ade24-c960-4235-956a-220260e5adac`); Nora remains the intended executor (`e9fe9b64-9b75-4280-b795-42158ae9cf16`). The following calls document the executable native contract, **not authorization to perform the later steps on this currently unready record**.

## 1. Read-only preflight

Grant calls `inspect_approved_message`:

```json
{"decision_id":"5e78f3a2-f0c1-42df-a236-c3882a53c320","expected_version":1}
```

A ready result supplies `scope`, `payload_hash`, `approval_event_id`, decision/version, and owner. Readiness is advisory; every mutation revalidates inside an immediate database transaction. A false result supplies concrete `missing_proof` and creates nothing. For this case, return that blocker to Boris; do not continue to acceptance.

## 2. Owner delegation — only when preflight is ready

Only the authenticated decision-owner bot calls `delegate_approved_message` with:

```text
{
  decision_id: preflight.decision_id,
  expected_version: preflight.decision_version,
  executor_conversation_id: preflight.scope.executor_conversation_id,
  request_key: "zcjal4-approved-nora-draft-bridge-20260923:delegate",
  scope: preflight.scope
}
```

Copy scope verbatim; do not reconstruct it. It contains `canonical_case` (equal to `payload.ticket`), `executor_conversation_id`, and the complete `payload`: channel, account, recipients, subject, body, customer, ticket, context, attachments. Each attachment has name, reference, and SHA-256. Structured scope must have existed in the immutable proposal snapshot before its human approve event. Delegation does not rewrite the proposal/answer, send anything, transfer ownership, wake a bot automatically, or share credentials.

Save the returned delegation `id` and `payload_hash`. The hash covers the entire canonical scope, including case and named executor—not just body or payload. One decision version permits one immutable delegation. Same-key exact retries return it; conflicting keys or scopes fail. The owner may explicitly hand off its ID and scope to the named executor using the existing authorized communication workflow.

## 3. Named executor acceptance

Only authenticated Nora, when named by the verified scope, calls `accept_approved_message`:

```text
{
  delegation_id: delegation.id,
  request_key: "zcjal4-approved-nora-draft-bridge-20260923:accept",
  scope: preflight.scope
}
```

It creates exactly one queued draft under the original verified approver’s authority, with an immutable acceptance event. It does not send. Exact same-key retries return the existing draft; changes or conflicting keys fail. This is distinct from ordinary `save_message_draft`, which remains unapproved until its own human send authorization.

## 4. Existing lifecycle and fresh claim

Grant must verify material evidence and complete the existing `record_decision_result` transition to RUNNING for this exact version. That path still requires delivered human approval and `material_evidence_unchanged:true`. Neither delegation nor acceptance changes decision state.

Nora independently verifies the current source account, recipient, canonical ticket/case, exact message, attachment hashes, lease, and duplicate-send history through her existing authorized connection. No source access is inherited from Grant. Then call `claim_message_draft`:

```text
{
  draft_id: accepted.id,
  claim_key: "zcjal4-approved-nora-draft-bridge-20260923:claim",
  send_check: {
    payload_hash: delegation.payload_hash,
    material_evidence_unchanged: true,
    recipient_account_case_verified: true,
    lease_and_duplicates_checked: true,
    evidence: <actual fresh source verification references>
  }
}
```

Those fields are truthful executor attestations, not substitutes for source checks. The platform revalidates native scope/approval/version/roles/registration/ownership/revocation and RUNNING status. Only `execute:true` permits one send attempt via the existing source transport. Preserve the returned `idempotency_key` and `approval_source`; the latter names the original human approval event and delegation. A repeated claim never returns another execution grant. Do not retry after ambiguous effects; reconcile source receipts.

## 5. Receipt, uncertainty, and revocation

For a verified send, call `record_message_delivery` with the same draft and claim key, `state:"sent"`, a real receipt summary, and:

```text
delivery_proof: {
  provider: <actual provider>,
  provider_message_id: <actual verified provider message ID>,
  account: preflight.scope.payload.account,
  recipients: preflight.scope.payload.recipients,
  canonical_case: preflight.scope.canonical_case,
  payload_hash: delegation.payload_hash,
  idempotency_key: claim.idempotency_key,
  verified: true
}
```

A queued operation or unknown ID is not proof. The platform verifies the binding and prevents conflicting/reused provider receipts; the executor remains responsible for verifying external truth. `uncertain` records the ambiguity without granting a retry. Reconciliation may record the actual verified receipt using the original claim. `failed` means definitely not sent and is terminal in this draft workflow. Recording receipt does not complete the business decision.

Grant can call `revoke_message_delegation` with `delegation_id`, stable `request_key`, and a concrete `reason`. Revocation blocks later use but cannot undo a provider effect. If already claimed, reconcile externally; never assume revocation means no send occurred. Version changes, access revocation, inactive/archived bots, executor ownership changes, and approval changes stop the bridge.

## API equivalents

All endpoints use existing authenticated actor identity; no body field can impersonate Grant, Nora, or Nicholas:

| Native tool | POST endpoint |
|---|---|
| inspect_approved_message | /api/bot-communication/approved-messages/inspect |
| delegate_approved_message | /api/bot-communication/approved-messages/delegate |
| accept_approved_message | /api/bot-communication/approved-messages/accept |
| revoke_message_delegation | /api/bot-communication/approved-messages/revoke |
| claim_message_draft | /api/bot-communication/drafts/:id/claim |
| record_message_delivery | /api/bot-communication/drafts/:id/receipt |

Inspect/delegate/accept/revoke retain the fields above. Claim/receipt put `draft_id` in the URL; the remaining fields form the body. No endpoint performs a provider send. No ordinary draft permissions were broadened.
