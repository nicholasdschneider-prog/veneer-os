# Approved canonical case and ticket binding

Build #250 · September 23, 2026 · Commission `william-case-ticket-binding-20260923`

**Blocked at the authoritative resolver integration prerequisite. No compatibility change was deployed.** Ali's existing approval was not edited or treated as withdrawn. No duplicate approval was requested. The completed $1,393.21 refund was not touched or replayed. No live decision, draft, delegation, acceptance, provider send, lease or customer mutation was performed.

## Confirmed boundary

The current [draft schema](/Users/archerclawdington/veneer-os/server/src/bots/draftPayload.ts) accepts independent strings for `canonical_case` and `payload.ticket`. The [delegation proof](/Users/archerclawdington/veneer-os/server/src/bots/messageDelegation.ts:68) requires their equality, and inspect, delegate, accept and subsequent validity checks reuse that proof. This constraint cannot establish whether two unequal identifiers refer to one case. Removing it alone would weaken identity validation.

The [bounded diagnosis](/Users/archerclawdington/Projects/ERVP/out/boris/william-approved-case-ticket-binding-20260923.md) reports decision `20c3a832-b1ba-4bd7-8a73-e09acb7cecd8`, version 1, owner Grant, actual Ali actor 2 approval, and named executor Avery `170ab267-448c-4b13-97f4-5f24db2f3652`. Its immutable scope uses canonical case `d2ebaeb6-f461-4bc8-b685-c9eaf888c103` and ticket `PDQD4N`. This build did not independently certify current live state or send eligibility and did not retry the live inspector. Both exact values must be retained; rewriting scope would not be a valid workaround.

## Supported source read found

[OrderOps GET /api/cs/conversations/:id](/Users/archerclawdington/Projects/ERVP/Order Ops/server/routes.ts:8640) uses authenticated `serviceOrSessionAuth` and returns the stored conversation, including its `id` and `ticketNumber`. Use the default read, without `includeOrderMatches=true`; the latter invokes unrelated enrichment. The underlying [storage read](/Users/archerclawdington/Projects/ERVP/Order Ops/server/storage.ts:1817) is available. No live source read was made by this builder.

[OrderOps access documentation](/Users/archerclawdington/Projects/ERVP/Order Ops/docs/orderops-veneer-full-access.md) requires the bot's own existing named credential, with fresh capability verification at `GET /api/order-completion/bot/capabilities`. That returns authenticated `access.principalId` and `fullOrderOpsAccess`. It is not a generic credential-transfer grant.

The [internal lease resolver](/Users/archerclawdington/Projects/ERVP/Order Ops/server/cs-ticket-leases.ts:164) can compare canonical ID and ticket in one source query, but it is internal lease code. It must not be invoked by creating or taking a live lease merely to prove this mapping.

## Exact integration prerequisite

Veneer's communication bridge currently has no server-owned OrderOps case resolver, source registration or verified binding between the current native chat, source principal, business and credential reference. The [AppContext](/Users/archerclawdington/veneer-os/server/src/context.ts) supplies general secret infrastructure, not this integration contract. The [existing CS custody guidance](/Users/archerclawdington/Projects/ERVP/.agents/skills/henry-cs-case-owner/SKILL.md) names source principals for Grant and Avery that are not the native chat IDs in this commission. Those may be legitimate distinct identifiers, but matching their display names is not proof of a current authorized mapping. No credential values were read, copied or logged.

Required before enabling unequal approved identifiers:

1. A server-trusted registration for the specific business/source origin and account, with verified mapping from each authorized native caller (Grant at owner stages, Avery at executor stages) to its actual enrolled source principal and existing use-time credential custody. A request body cannot choose a credential, tenant, business or arbitrary source URL.
2. Authenticated live source reads under that binding: capabilities must identify the expected current principal, then the exact canonical-case GET must return the approved UUID and ticket code unchanged. Missing, conflicting, inaccessible or foreign-business responses fail closed. Source account/business isolation must come from the trusted registration, not a copied label in the approval payload.
3. Defined freshness and drift handling through inspect/delegate/accept/claim/delivery: server-fetched provenance and mapping fingerprint are supplemental evidence, never replacements for the immutable approved scope or full payload/proposal hashes. Revalidate before each executable stage; reject stale or changed mapping and reconcile uncertain delivery without issuing another send.

No existing supported bridge contract establishes item 1. General Doppler access and the existence of the GET route do not establish it. This is a source-integration prerequisite, not a request to reapprove William's message or a claim that Ali's instruction is invalid.

## Supported implementation path once the binding is established

Use the existing authenticated capability and canonical-case GET endpoints through a narrowly scoped server resolver; no OrderOps write or replacement messaging transport is needed. Pin the allowed origin/business/account and caller-to-principal binding in trusted configuration, keeping secrets out of requests and audit records. Return only exact IDs plus nonsecret source provenance/currentness to the bridge. Preserve both approved strings and all original approval/event/version/recipient/body/account/attachment/executor hashes. Persist a separate resolver fingerprint with delegation evidence and check it at every later stage.

Keep the existing equal-identifier path and ordinary drafts compatible. Tests must exercise successful UUID/code mapping, absent/conflicting/foreign mappings, changed scope and source drift, revoked source/native authority, and concurrent/replayed one-time claims and receipts. No arbitrary `same_case=true`, local hand-maintained alias row, approval retrofit, synthetic human approval or case-specific exception is an acceptable substitute.

This describes the integration path, **not an available executable API**. Until trusted resolver enrollment exists, use the existing inspector only to observe its fail-closed result; do not delegate, accept or send around the guard. Root's independent inspection remains required before Avery resumes.

## Release status

Only this report changed. No application capability or schema changed, so no source tests, build, restart, new runtime-health claim or deployment receipt applies. The requested repair and its test matrix remain outstanding; documentation is not reported as implementation. Build #229's exact approval contract and #232's separate standing-policy prerequisite remain unchanged. All narrated-teaching and intervening work is preserved.

Owner remains Platform Dev chat `732adce5-ea99-45d4-be9d-07ae47e02133`. Boris `9bb5b47e-b9c9-43c0-a83b-7dc485166c0f` receives this prerequisite receipt. No new bot, duplicate queue job or slot timer was created.

Changed file: [this report](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/README.md).

## Affected-record addendum: Joseph

User-supplied addendum to this same build/commission only; no new research or live inspection. Decision `e1873e7e-9906-474c-94a6-c4ba9be66a58` version 2 is reported Ali-approved, with the same equality failure: canonical UUID `174fd3fb-9f2c-4b8d-a038-cbf212630748` versus approved `payload.ticket` `JKAF95`. Named executor Tess: `1e96b7bb-1071-4f1d-b710-310f9fbbc9e1`. Root recorded blocked; no delegation or send is reported. Preserve the immutable approval and both strings; no retrofit or duplicate approval.

The September 23 shipment-plan wording “today” becomes stale on date change and requires fresh material review before any future execution. It grants no refund authority. This is an additional affected record alongside William, not evidence that the resolver prerequisite is fulfilled or that a repair shipped. The same trusted source connection and native-to-source principal mapping remain unestablished. No live case action was performed.
