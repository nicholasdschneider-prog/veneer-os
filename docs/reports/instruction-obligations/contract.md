# Separate SMS intent after consumed email consent

Released September 28, 2026. This contract preserves an outstanding direction; it does **not** authorize the later SMS draft. Existing conversational answer uniqueness and all email/send guards remain unchanged.

## Original-owner workflow

1. The original source-owning bot calls `inspect_instruction_obligation` with exact `source_id`, `draft_id`, `expected_draft_version`, and `executor_conversation_id`. The source must be a server-captured direct human message with an existing immutable conversational answer. The named executor must own the exact accessible SMS draft in the same native owner/business scope.
2. Read the entire human message, original captured proposal, existing answer receipt, returned native human/discussion/result context, and current owning conversation. Determine whether a separate direction remains outstanding; never infer consent from keywords, quotations, a draft's context field, or a bot summary.
3. To retain the intent, call `record_instruction_obligation` with the same inputs, returned `inspection_hash`, a stable `request_key`, a concise `intent_summary`, and `reviewed_full_context:true`. The summary is explicitly the reviewing bot's classification, not a human approval. One append-only record per source/draft preserves the exact draft version, full payload and hash, executor, source/captured proposal/answer hashes, current observation/context, and actual recording time. It never backdates a draft snapshot.
4. Read-only inspection of the same inputs reconciles a lost recording response and reports the original record, revocation, and drift. Identical recording retries return that record; conflicting retries cannot replace it. Use the current draft version when inspecting a subsequently edited draft; the old immutable snapshot remains visible and changed.
5. The original owner can append `revoke_instruction_obligation` with `obligation_id`, `reason`, and stable `request_key`. This revokes only the intent record, never reverses an external effect or erases the outstanding customer request.

## API

Authenticated original bot routes under `/api/bots` (strict JSON):

- `POST /instruction-obligations/inspect`: read-only despite POST, no pending-turn edits or wakes.
- `POST /instruction-obligations`: record the owner-reviewed intent.
- `POST /instruction-obligations/:id/revoke`: append immutable revocation.

There is no executor impersonation, provider call, authorization, delegation, claim, delivery, or obligation-completion endpoint. All inspection/record results contain `ready:false` and `execute:false`. Nothing is automatically recorded on discovery. No production obligation is created by deployment.

## Exact boundaries

Every inspection retains `EXACT_LATER_PAYLOAD_AUTHORITY_MISSING` and `AUTHENTICATED_SOURCE_CASE_LINKAGE_MISSING`. The implementation accepts no `same_case`, alias, credential, authorization, or link assertion. The existing email answer authorizes only its original scope. An SMS instruction alone does not establish authority for every word subsequently drafted or prove a phone sister belongs to a canonical email case.

Source author and caller access, source-owner/executor active registration, shared business and owner, original consumption source hash, captured proposal version/hash, and original human answer event are checked. Inspection includes full bounded native direct-human records, the consumed decision's complete discussion/events, and original results/replies since the instruction. It fails rather than truncates at 500 records per collection or 120,000 context bytes. This is not a replacement for the original bot reading its current conversation; unrelated private histories are never granted to the executor.

A new human message, changed proposal, changed draft/payload/version, inactive identity, or explicit revocation cannot become fresh execution proof. Inspection exposes drift; revoked access denies inspection. Drafts already authorized/bound or with possible effects cannot create a new intent record. Existing records remain immutable; observed `sending`, `sent`, claim/receipt presence is reconciliation-only. Claim keys and receipt contents are not returned.

SQLite immediate transactions plus unique source/draft and owner/request-key constraints serialize recording; immutable triggers protect both ledger and revocations. Recording writes only these separate ledgers, never the original source/answer/proposal/draft, grants, wake queues, or delivery records. No financial/send authority exists in this release.

## RRCDGC acceptance boundary

Grant is the original source owner and must perform any production inspection himself. Tess remains the SMS draft owner and eventual executor only under separately established exact authority. Refreshed native evidence at implementation showed the unchanged source already consumed for email v5, while the later SMS draft remained ordinary/unbound. The SMS draft's own context asserts a phone-sister relation but is not authenticated linkage evidence.

To progress beyond intent, the missing evidence is (a) an accepted authority contract for the exact later SMS payload/account/recipient/executor, consistent with the full authenticated human instruction, and (b) source-authenticated canonical-email/phone-case correspondence. This release deliberately does not manufacture either, retrofit the ordinary draft, reuse email approval, or ask for another customer approval as a technical workaround. No live send readiness or customer delivery is claimed.
