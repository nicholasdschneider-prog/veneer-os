# Approved Gmail existing-draft binding v1

October 14, 2026. Staged native implementation, not deployed or Gmail-accepted.
No business mutation, Gmail/provider test, secret read, source edit or send was
performed. The technical build is not business authorization.

## Exact interface

Original authenticated decision owner must also be the named executor.
POST /api/bot-communication/approved-messages/gmail/inspect accepts exactly:

- decision_id, expected_version, draft_id, draft_version
- thread_id, reply_message_id (Gmail message ID), reply_rfc_message_id

MCP tool: inspect_approved_gmail_draft. IDs are exact opaque literals, not aliases,
case UUIDs or account labels. Existing OrderOps resolution is unchanged.
The inspection is execute:false and returns the unchanged approval/scope, existing
payload, complete bounded native decision context, separate approved/draft payload
and context commitments, source fingerprint/revision and deterministic inspection_hash.
More than 1,000 events or discussion messages, or 1 MiB native context, denies
rather than returning an excerpt. Inaccessible historical proposal context denies.

POST /api/bot-communication/approved-messages/gmail/bind (MCP
bind_approved_gmail_draft) takes the same target plus inspection_hash, request_key
and review. Review is the original owner's accountable semantic interpretation,
not a keyword parser, new approval or source credential:
approved_context_hash, draft_context_hash, interpretation=operational_provenance_only,
scope_explanation and segments[]. Each segment carries start/end (JavaScript string
offsets), exact text, classification=provenance_without_authority_change and explanation.
Segments must cover every character contiguously and exactly. Unsupported,
ambiguous or conflicting interpretation must not be submitted as provenance.

Only empty approved context versus nonempty operational provenance is supported.
Channel, account, recipients, subject, body/signature, customer, literal ticket and
ordered attachments must match exactly; no normalization, truncation or rewrite.
Both full payload hashes remain distinct. Context difference is explicitly reviewed,
not blanket-ignored or represented as hash equality.

Parser: server/src/bots/approvedGmailContract.ts.
Receipt: approved-gmail-binding/v1 with execute:false, replayed, delegation_id,
draft_id, decision_id/version, approved_payload_hash, draft_payload_hash and
inspection_hash. Binding never grants dispatch entitlement.

## Required native source boundary — NOT installed

ApprovedGmailReader is a server-installed integration, never a JSON parameter.
read(authenticated Actor, exact target, immutable scope) returns strict
approved-gmail-source/v1 evidence and a synchronous revalidate callback.

Evidence fields: schema_version, caller_id, user_id, business_id, connection_id,
principal_id, custody_hash, account, thread_id, reply_message_id,
reply_rfc_message_id, latest_inbound_id, recipients, source_revision, material_hash,
attachment_hashes, observed_at, expires_at, decision_id/version and scope_hash.

The adapter must independently select the actual original caller's permitted Gmail
connection, verify actual authenticated account/principal (not display labels), read
the complete bounded thread and exact reply anchor, prove latest inbound and current
material/recipient mapping, and verify actual attachment bytes. It must reject
incomplete/foreign/revoked source scope. revalidate synchronously rechecks original
connection/custody access inside native IMMEDIATE operations. Both methods are
trusted native code and cannot accept copied agent assertions as source proof.

Observation is at most 5 seconds old at consumption, with at most 15 seconds total
read/operation time and observation lifetime; clock reversal/future/expiry denies.
Scope includes exact proposal and caller, with no alias inference. The literal
ticket stays an approved label; Gmail evidence does not assert it is a case UUID.
Fingerprint commits identity, custody, scope and material; source revision is
independently compared on later checks.

Existing connector draft helpers are not this authenticated complete-thread
attestation. The default production factory has no reader and reports the exact
missing interface before any business binding. Platform owns this native adapter;
the original accounting Gmail connector custodian must establish actual permitted
connection/account identity. Clara retains sole business execution. Boris coordinates.
This build creates no grant, enrollment, connection sharing or provider adapter.

## Durable binding and later delivery

Inspection revalidates current human approval attribution, immutable snapshot,
approver/owner/executor access and same business. Binding repeats inspection after
fresh source read and inside SQLite IMMEDIATE, verifies inspection and complete
context review, and writes one immutable supplemental audit plus existing delegation
and acceptance events. It changes only existing draft authorization/delegation/state;
payload_json and version are preserved and become database-protected.
This is an explicit prospective operation, not backdated authority import.

A permanent unique decision binding, draft binding and action digest prevent
replacement-key/version/draft escapes. Action commits business, account, exact
thread/reply and send material. Competing non-discarded drafts or any prior claim,
authorization, delegation or receipt on a sibling deny. Existing direct-vendor
authority also blocks this path. Generic delegation cannot create a new draft for
Gmail evidence; existing UUID paths retain their meanings. Ordinary claim rejects
a different draft for the bound decision or identical send material under the same
original executor. No fallback draft is created.

Original owner performs RUNNING and current material/recipient/duplicate checks.
Normal claim uses the fresh typed Gmail resolver and revalidates supplemental
commitments. First claim alone can entitle one later original-owner send; replay
and UNKNOWN remain non-retryable. Exact bind replay returns the stored receipt only.
Changed request, scope, source revision, custody, draft/version, revocation or
approval conflicts. Supplemental authority context commits the proposal, answer, handling revision and complete decision discussion; later discussion blocks delivery without clearing the reservation. Lifecycle RUNNING events alone do not alter that commitment. No source receipt is fabricated. Existing claim/delivery
contracts remain in force. This is not Gmail transport implementation or case readiness.

Deployment requires an explicit approved maintenance window and drained turns.
