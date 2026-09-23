# Routine draft authority — enrollment prerequisite

September 23, 2026 · Native build #232 · Commission `build203-routine-draft-authority-20260923`

**Blocked before implementation at the requested trustworthy-enrollment check. No routine-send capability was deployed.** BUILD203 business authority is documented; this finding does not revoke it or request another per-case human approval. No application source, schema, guide capability, production draft, decision, customer record, lease, or provider state was changed. Build #231/runtime commit `d719e07` and the #229 contract are preserved.

## Evidence inspected

- [Bounded diagnosis](/Users/archerclawdington/Projects/ERVP/out/boris/bgtjqk-routine-draft-boundary-20260923.md).
- [Canonical CS rules](/Users/archerclawdington/Projects/ERVP/.agents/skills/henry-cs-rules/SKILL.md): the complete September 22 BUILD203 section, its constraints, later corrections, and the separate specialist exceptions. The BUILD203 section content hash (text after its heading, before the next heading) is `89d0686d91f1c89a084d87708bf03c0ff599c7f3fc9eeb7cce580c8a0a734c71`. This is a reference fingerprint, not an authorization signature.
- Read-only authenticated transcript of source chat `74c737a3-bd2b-4409-9e77-188a67d4226a`: original user turn `5c5878da-e772-4366-bdda-245f56c426ec`, September 22 at `19:11:24.046Z`, text “Ok make those changes. I trust you”. That retained event has `type`, `turnId`, `role`, `text`, `at`, and `via`; it has no authenticated actor ID or structured policy enrollment. Later bot messages quoting the instruction are not substitutes for the original human actor record.
- [Draft service](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts), [communication routes](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts), [exact approval bridge](/Users/archerclawdington/veneer-os/server/src/bots/messageDelegation.ts), [business enrollment](/Users/archerclawdington/veneer-os/server/src/bots/teams.ts), [native tools](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts), and current migrations. Existing business enrollment delegates membership administration, not customer sends. The current bridge requires a per-case immutable human approval and cannot stand in for BUILD203.
- [Conversation runtime](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts): queued actor identity is used for execution; a running queued message is removed from the queue. A retained transcript's user role or conversation ownership alone must not be promoted into a new historical authorization record.
- [AutoShip verifier](/Users/archerclawdington/veneer-os/server/src/bots/verifierRoutes.ts): its dedicated read-only decision contract is not a generic routine-policy or CS lease/material verifier.

## Precise prerequisite

Before an executable routine-draft bridge can enroll this historical policy, establish a supported **owner-authenticated policy enrollment basis**, distinct from approving any individual draft. It needs:

1. An immutable policy snapshot/version containing the full dated scope and exclusions, with verifiable original human-source attribution, or an explicitly authenticated owner enrollment of that existing scope. Do not infer the historical actor from conversation ownership, create an invented `authorized_by`, or treat a mutable skill path/hash as a signature.
2. An explicit business binding and exact native executor IDs for the eligible retained owners, plus current issuer authority, revocation and superseding-version semantics. Names, membership and own credentials alone are insufficient.
3. A supported eligibility contract for each enabled category, including source-backed retained ownership, current own-principal exclusive lease, material context/holds, and duplicate/unknown-effect status. Merely accepting `category=missing_information` or a caller's `eligible=true` would allow arbitrary draft content. Unsupported categories must remain disabled with a specific prerequisite.

No supported routine-policy enrollment operation or record was established by this inspection. No existing approval, member-enrollment or AutoShip contract supplies that missing authority. The user explicitly required returning the concrete prerequisite if this basis was unestablished, rather than inventing an attestation. This report records that result. It does not automatically request a fresh human approval, authorize an administrator to enroll policy now, or require reapproval of every covered case.

## Exact scope to preserve when enrollment is established

The policy must preserve missing-information/model/fitment/photo asks without remedies; qualified no-order factual catalog answers without commitments; eligible unused returns only under existing file-first checks; accurate existing RMA/claim/policy restatement; specified verified completion; and narrowly verified factual tracking. Completion/no-contact categories do not imply permission to send an extra message. Specialist claims and Dometic exceptions are not generic routine authority. Financial remedies, cancellation, credit, replacement, discount, purchase, exceptions and other human-gated actions stay outside this bridge.

An eventual executable acceptance contract must bind immutable policy/version/category, eligible own executor, canonical case, exact account/recipient/subject/body/attachment hashes, and current source checks. The draft must carry a distinct standing-policy basis, without a synthetic human approval. Claims must be one-time and transactional, with stable source idempotency; unknown outcomes permit receipt reconciliation only. Revocation or scope/version changes must invalidate unexecuted bindings. Ordinary human draft authorization and build #229 remain separate.

There is deliberately **no executable enrollment/acceptance command in this report**: inventing a tool name or presenting a proposed endpoint as available would misrepresent the prerequisite as solved.

## Live fixture and release status

Avery BGTJQK draft `49fa5f0c-e657-4f51-a7e8-812744bc041f`, canonical case `00de5fa6-9e02-498f-8121-99ccb9c337f0`, request `avery-bgtjqk-35d80e07-v1`, and HOLD `05dbf5bb` were reference identifiers only. No live claim, mutation, authorization, send or customer eligibility test was performed. This report does not independently certify the reported current draft state or lease state. Rob/Arthur legacy approvals were not altered or imported. No old OrderOps POST fallback was used.

Only this report was created. No source change was made, so no source validation, build, restart or new deployed-health claim is applicable. The implementation and its requested test matrix remain outstanding pending the enrollment basis above; documentation is not reported as a completed repair. No new feature was added to the employee guide or resumed-agent catalog because none shipped.

Platform owner: existing chat `732adce5-ea99-45d4-be9d-07ae47e02133`. Handoff recipient: Boris `9bb5b47e-b9c9-43c0-a83b-7dc485166c0f`. No duplicate queue job or slot timer was created.

Changed file: [this prerequisite report](/Users/archerclawdington/veneer-os/docs/reports/routine-draft-authority/README.md).
