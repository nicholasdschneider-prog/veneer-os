# Prospective correction authority — BUILD450

This is a new native contract, `native-compose-sms-correction/v1`. It does not change conversational consent, instruction obligations, unchanged-consumption composition, or any source dispatch schema. Original decisions/answers, consumption, drafts and old authority tuples remain immutable. No production correction is recorded by this deployment.

## Original-owner APIs

`POST /api/bots/composed-sms/corrections/inspect` (`inspect_composed_sms_correction`) requires:

- `source_id`: the original consumed direct-message lineage anchor, not the correction.
- `decision_id`, `expected_decision_version`: its exact current unanswered decision revision.
- `lineage_draft_id`: the original executor's ordinary SMS draft, created before the correction, with no authorization or possible effect.
- `draft_id`, `expected_draft_version`: the corrected ordinary draft, owned by that same executor.
- `executor_conversation_id`, `canonical_case`, `contact_case`: original executor and distinct exact canonical UUIDs.
- `correction_source_kind`: `direct_message` or `result_reply`; `correction_source_id`: exact authenticated human message in the original owner's conversation.

Only the original registered active owner can inspect. The correction author must retain current authority to answer the decision. Original consumption/answer provenance is still verified, but is retained as history rather than required to match the revised proposal. Full direct messages, all result replies and their original anchors, decision discussion and events are bounded without excerpt truncation. Later human input supersedes the selected correction. Current proposal/version/handling, exact drafts, source/context hashes, and source projection/custody/sender commitments bind the inspection.

The corrected payload must retain every original payload field except body: account, channel, recipient, customer, ticket, context, subject and attachments. Only one-recipient plain SMS is supported. Distinct customer IDs and null order relations are preserved; authenticated customer messages from both cases support the owner's relationship interpretation, never alias inference. A later draft cannot establish the original account/recipient/executor scope.

Unavailable source evidence produces `ready:false`, `execute:false`, `inspection_hash:null`, complete native context and a concrete missing-proof reason. This incomplete result cannot derive authority. An inspection with current evidence still does not authorize execution.

`POST /api/bots/composed-sms/corrections/derive` (`derive_composed_sms_correction`) adds exact `inspection_hash`, stable `request_key`, and strict review:

- Existing composition review fields: mode, full-context review, exact complete recipient/composition/channel citations, purpose, relationship explanation, customer message IDs, contiguous body-span review and unresolved choices.
- `instruction_kind`: `compose_and_send`, `wording_edit`, `status_question`, `quoted_or_reported`, `conditional`, or `ambiguous`.
- Complete `correction_instruction` and `send_instruction` citations to the correction itself, plus a reasoned `interpretation`.

Only unconditional `compose_and_send` with no unresolved choices and supported coverage of every body character is eligible. Original-owner semantic interpretation is accountable human-context review, not automatic language classification. The server authenticates authorship, citations, facts, revisions and exact scope; it does not infer consent from words or accept historical email/channel approval as the new send instruction. A wording edit or “So you sent that?” must be classified accordingly and is rejected. Deliberately misclassifying prose is not a supported use of the API.

Fresh authenticated sender, effective-process evidence, service custody and matching material/issuer/executor bindings are mandatory for recording. Source remains responsible for its independently enforced sender/process, scope and recipient-timezone gates. No source or provider call is made by the builder.

## Immutable proof and shared duplicate fence

A successful record creates prospective authority in the existing immutable composed-authority table. Its `proofKind` is explicit; its `source_id` column remains the historical anchor required by the existing foreign key. The actual correction and its provenance are separately bound in the snapshot and tuple. No fictitious consumption row is created. There is no schema migration or rewrite.

The action fence is exactly the existing `canonicalSha256({business_id, decision_id, channel:'sms'})`. The unique action constraint covers historical and correction authorities, copied drafts and changed keys. An existing action, even revoked/expired/UNKNOWN, cannot be replaced. Concurrent identical records return one authority; conflicting scope/key requests fail. Native dependency and source freshness checks run again inside the immediate recording transaction. Ordinary message claims recognize the new authority through the existing shared table and cannot bypass it.

The strict native tuple schema is `correctionAuthoritySchema` in [composedSmsCorrection.ts](/Users/archerclawdington/veneer-os/server/src/bots/composedSmsCorrection.ts). It binds full payload hash, identity-preserving wire hash, correction provenance/hash, complete context hash, current decision revision, native binding hash, review hash, historical consumption hash, source material/custody/principal, original owner/executor, both cases, runtime, sender receipt/revision, and truthful derivation/expiry timestamps. The authority hash is `composeHash('native-compose-sms/correction-authority/v1', all tuple fields except authorityHash)`. The existing wire domain remains `native-compose-sms/wire/v1`. No normalization is introduced. Expiry is bounded by the earliest authority window, sender observation and checked service dependency expiry.

The synthetic [vector](./synthetic-correction-v1.json) has authority hash `92a99ca88187409cdd8d1a8e06b1532b0936845d19c47e596e2e06f9e31d766e`. It is parser/hash evidence only, not real authority or source facts. Earlier wire vectors are unchanged.

## Reconciliation and explicit dispatch dependency

`POST /api/bots/composed-sms/corrections/reconcile` (`read_composed_sms_correction`) is read-only and takes the original `decision_id`, `source_id`, and derive `request_key`. It performs no external read and returns the original immutable authority, if present, plus native-current/expired/revoked status. Lost responses, expired sender observations or new context never grant another attempt. If the authority ID is known, existing `read_composed_sms` reads it and `revoke_composed_sms` appends revocation. Neither enables dispatch.

**No v1 service export, accept, claim or dispatch is available for correction authority.** Those paths explicitly fail with `CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE`. Existing unchanged-consumption APIs keep their historical semantics and rejection behavior. No service dispatch row is produced by this native correction record.

The precise next integration dependency belongs jointly to original native owner Platform732 and sole source owner ae5d6289. Source accepted the separate contract direction at 2026-09-29T03:11:40.096Z. Before coupling, source must agree a new versioned service authority proof distinguishing correction provenance/context/current revision from historical consumption, committing the complete corrected payload/wire scope and retaining this original action fence through source prepare/redemption/readback. Native cannot relabel this tuple as v1 or supply an invented `existing_consumption.source_hash`. The native-only tuple contains owner-visible correction text; any source-facing projection and its data scope must be explicitly accepted, not silently added to existing service routes. No source job or source edit is created here.

Expired sender evidence, actual same-process sender identity, recipient timezone and complete hold/scope classification remain separate factual gates. Source closure is intentionally incomplete for correspondence/freeform and other unsupported evidence. Synthetic success does not establish Brian/global inventory readiness or unrelatedness. Do not request duplicate customer approval, infer case aliases, retire drafts or weaken completeness to bypass these limits.
