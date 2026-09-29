# Composed SMS evidence and prospective authority

September 28, 2026. BUILD432 continues BUILD431. Native code does not enable live SMS by itself.

The original source-owning bot uses `inspect_composed_sms` with exact `source_id`, `draft_id`, `expected_draft_version`, `executor_conversation_id`, `canonical_case`, and `contact_case`. The server verifies original authenticated human source and immutable email consumption, current native access, original proposal and exact ordinary SMS draft. It reads the full bounded native context and directly fetches authenticated source correspondence. Neither uploaded JSON nor bot-provided equivalence assertions are accepted as source proof.

## Source interface and custody

Fixed source origin: `https://orderops-dev-web-production.up.railway.app`. Exact read sequence:

1. `GET /api/cs/approved-case/capabilities`
2. `GET /api/cs/approved-case/correspondence/:canonicalUuid/:contactUuid`
3. `GET /api/cs/approved-case/capabilities`

No queries, redirects, broad case fallback, token forwarding to another origin or identity borrowing. Each actual owner/executor uses its own registered credential at use time. No live credentials are read by BUILD432.

Separate `VP_COMPOSE_CORRESPONDENCE_REGISTRY_FILE` is required. It is an absolute, non-symlink, service-user-owned regular file with mode0600 and maximum128KiB. Its strict schema is `correspondenceRegistrySchema` in `server/src/bots/composedSmsReader.ts`: schema_version `compose-correspondence-registry/v1`, registrations carry current business/owner/source account/runtime/origin, caller-to-principal and protected credential references, explicit expiry, and provenance authority `compose-send-correspondence-custody`. A genuine source-custodian receipt extending correspondence/customer-data read custody is necessary; BUILD429's approved-message-resolver registry is rejected. BUILD432 installed no registry. BUILD434 activates the separate six-caller registry under the retained custodian extension; see [activation report](./build434.md). Its expiry remains October 28, 2026 at21:04UTC or earlier revocation.

The consumer pins source BUILD433's documented `approved-case-correspondence/v1`: canonical/contact case order, all persisted message rows ordered conversationId/id, strict fields, complete counts, declared omitted media/HTML/transcription,500 combined messages and1MiB response limit. Null fields and distinct customer IDs remain unchanged. Entire envelope hash excludes only observedAt/expiresAt/snapshotHash. Source identity is checked against native custody twice; the native material digest excludes independently authenticated caller identity so the same facts can be compared across owner and executor. No relationship classification or merged-customer assertion is inferred.

The observation expires15seconds after source transaction start, with maximum5seconds local use after read and15seconds total native round trip. Registry, participant identity and expiry are checked again inside native transactions. Cross-system atomicity is not claimed.

## Semantic review and immutable authority

`derive_composed_sms` adds exact inspection_hash, stable request_key and review:

- mode `compose_and_send`; reviewed_full_context true;
- complete exact recipient_instruction, composition_instruction and channel_instruction human citations `{id,text}`;
- purpose, relationship_explanation, customer_message_ids from both cases;
- contiguous parts covering every UTF-16 body character: start/end, supported assessment, human_ids, message_ids, explanation;
- empty unresolved_choices.

The original owner must interpret complete human instructions and source facts. Server provenance/hash checks do not certify arbitrary semantic assertions. A channel-only message, unsupported addition, ambiguity, omitted necessary media or a new business choice cannot establish authority. No keyword parser decides consent. Later drafting is allowed; current verified sender evidence is still required. The current v1 source has no such evidence, so inspection returns facts plus `SMS_SENDER_OWNERSHIP_UNVERIFIED`, and derivation remains blocked.

When evidence permits derivation, a new immutable prospective record stores actual derivation time, exact body/account/recipient/cases/executor, full native/source evidence and semantic review. Email answer and consumption, original proposal and ordinary draft remain untouched. Action identity is business + original consumed decision + SMS channel, independent of draft copies, version, source and request keys. One immutable authority per action prevents replacement/replay. Expired or revoked authority cannot create another attempt; reconcile the original action. This release does not supply an automatic renewal/replacement path.

## Acceptance, claim and receipt

Tools map to `/api/bots/composed-sms`: POST `/inspect`, POST `/derive`, GET `/:id`, POST `/:id/accept`, `/claim`, `/delivery`, `/revoke`. Request schemas are strict. Only original owner may derive/revoke; only named executor may accept/claim/deliver. Read is limited to those participants and returns bounded exact scope/status/receipt, not the owner's private context.

Acceptance rechecks current source/native snapshot and exact payload hash. Claim requires fresh checks, acceptance and send_check covering current material, account/recipient/case, lease, duplicates, suppression and local-time restrictions. A server-owned reader must additionally supply accepted `native-compose-sms/v1` transport; current source reader supplies no transport, so claim fails before reserving. Tool requests cannot supply or override that evidence. The internal lifecycle's positive synthetic adapter is a fixture, not a deployed source protocol.

If a supported source adapter is later implemented and accepted, only the first atomic claim returns execute:true plus claim_key and stable `veneer-compose-sms:<action-id>` idempotency. All later claims return execute:false; missing receipt is UNKNOWN. Do not invoke generic manual-SMS as a workaround. Source must bind the native action, exact executor, actual sender, unchanged wire body/recipient and authorization, reserve durably before provider dispatch, and preserve UNKNOWN without another attempt. Existing manual-SMS normalization and actor/sender-free hash are insufficient.

`record_composed_sms_delivery` requires original claim actor/key plus verified actual provider ID and exact account/recipients/canonical case/payload hash/idempotency. This is the original executor's proof submission, not an independent native provider probe. Identical retries are stable; conflicting keys/provider proofs or reused provider receipts fail. Revocation appends an immutable event and never undoes external effects. No customer/provider action is performed by native receipt recording.

## Activation dependencies

1. Source433 deployment and separate correspondence custody are recorded in BUILD434. Original callers can inspect; this does not satisfy sender or dispatch evidence.
2. Authenticated current SMS account/fromPhone ownership evidence with provenance/revision; configured credentials or historic inbound destination are insufficient. Current v1 only emits unknown.
3. Agreed and implemented source-enforced native-action dispatch association, exact wire payload and durable UNKNOWN/readback contract. Current generic manual-SMS route cannot consume a native action grant.

These are technical source prerequisites, not another customer approval. Grant performs the supported original-owner review after those prerequisites; Tess retains eventual separately guarded execution. The builder does not inspect live cases, enroll, create authority or send.

## BUILD435 — dedicated service dispatch boundary

This supersedes BUILD432's synthetic bot `execute:true` path. Bot claims always return
`execute:false`. `action_id` retains the old stable intent digest for deduplication;
`native_action_id` is a separately persisted UUID. Only prospective derivation with a
server-authenticated boundary adapter can create that UUID/authority tuple. Existing
records are never upgraded or rehashed. The deployed correspondence v1 reader cannot
produce positive sender or guard evidence, so live dispatch remains unavailable.

The native verifier prefix is `/api/composed-sms/verifier`. Every route independently
requires a dedicated Cloudflare service JWT AND a separate bearer credential whose
SHA-256 matches the protected registration selected by `X-Compose-Registration-Id`.
No human session, bot bearer, return/routine identity, or generic API fallback applies.

- `GET /authorities/:authorityId?revision=1&actionId=:uuid`: exact immutable tuple,
  `execute:false`, no private human context and no new reservation.
- `POST /dispatch-associations`: strict `schemaVersion`, `nativeActionId`,
  `authorityId`, `authorityRevision`, `nativeClaimId`, `sourcePrepareId`,
  `bindingHash`, `requestKey`. Only the first durable transaction returns
  `dispatchEntitlement:true`; this is not a bot execution permission.
- `GET /dispatch-associations/:id` or `GET /actions/:actionId/association`:
  exact authenticated reconciliation, always `dispatchEntitlement:false`, `execute:false`.
The named executor's existing `record_composed_sms_delivery` tool requests authenticated
source readback using its existing reservation. No new service mutation route is added
for receipts. The server never accepts a provider ID from the request and never calls
a provider; `delivery_proof` is no longer accepted.

Exact schemas are in `server/src/bots/composedSmsContract.ts`. Canonical JSON uses
recursive ordinal-key sorting, exact UTF-8 strings/nulls and original array order.
Domain-separated SHA-256 covers `native-compose-sms/authority/v1`,
`native-compose-sms/wire/v1`, and `native-compose-sms/binding/v1` with the pinned tuples.
`sms-identity-utf8/v1` permits no text transformation. Source must deny if its legacy
`smsPlainText` output differs from the reviewed wire bytes. Media is exactly `[]`.
`compose-correspondence-material/v1` removes only `identity.principalId` after checking
that caller's complete source envelope. It retains account/business/runtime identity.
The old BUILD432 digest and original source433 envelope hash remain unchanged.

The native server reads only the fixed source endpoint
`GET /api/cs/composed-sms/actions/:nativeActionId` using separate protected service
readback custody, with no redirects, query, fallback, or bot credential borrowing.
Before associating, it requires persisted `REDEEMING`, exact prepare/claim/binding,
no attempt or receipt yet, current native context, current registration and original
executor acceptance/reservation. Its immediate transaction uniquely consumes action,
claim, registration+prepare and registration+request key. Source observation is bounded
and rechecked after the network call. No expired or lost entitlement is renewed.

### Required pin clarification; no old-DTO dispatch

The original pinned readback omitted two facts necessary for safe redemption:
`prepareExpiresAt` (original persisted UTC expiry, never refreshed) and
`redeemRequestKey` (null before redemption, then the exact persisted key). The native
parser allows them as an explicit extension, but association fails
`DISPATCH_BOUNDARY_UNAVAILABLE` unless both are present and current. This correction
was sent to source owner ae5d6289 in the existing coordination thread under request key
`build435-prepare-evidence-expiry-key-20260928-v1`. Source acceptance/deployment of the
extension is a remaining integration prerequisite; this document does not assert it.

A permit lasts at most 15 seconds and never past the authority, sender, registration
or source prepare expiry. A lost first response is UNKNOWN. GETs and retries cannot
permit sending. Source must CAS PREPARED→REDEEMING before redemption, recheck actual
locked guards after the first response, and durably commit SENDING before its sole
provider call. Native association and source attempt commits are separate linearization
points; there is no distributed atomicity or post-check revocation guarantee.

Readback `SENT_ACCEPTED` requires the stored association/claim/prepare, action,
authority/wire hashes, idempotency, attempt, provider account, sender and recipient.
A separate immutable receipt audit records the authenticated source's persisted
acceptance. Provider acceptance is not delivery. UNKNOWN stays UNKNOWN without a retry.
Conflicting receipts or reused provider IDs fail closed. Revocation and native context
changes can block receipt reconciliation; they do not erase any possible external effect.

### Configuration and remaining activation dependencies

`VP_COMPOSE_SERVICE_REGISTRY_FILE` must point to a separate absolute regular
non-symlink service-user-owned mode0600 file, at most128KiB. Strict
`composeServiceRegistrySchema` is the executable schema. It pins actual registration
revision, business/current owner, source account/origin/runtime, service principal,
bearer hash, unique dedicated CF audience/client, executor/native-user/source-principal
bindings, sender receipt issuer, accepted guard-contract hash, expiration, custody
receipt, and a separate protected source readback credential reference/receipt.
No secret value belongs in the registry, repository, logs, or request parameters.
Current ownership, registration and executor access are rechecked on every operation.

No service registry or credential was provisioned by BUILD435. No positive sender
wire schema/issuer or source guard inventory has yet been jointly accepted. The native
`ComposeBoundaryEvidence` interface is server-internal adapter output, NOT a source
request schema or a bot assertion. A future accepted adapter must authenticate issuer,
receipt expiry, current effective provider client and actual guard coverage, then
recheck through `assertFresh`; correspondence v1 intentionally cannot supply it.
Synthetic fixtures exercise this boundary, not production sender readiness. These
missing contracts, the readback extension, and actual dedicated bidirectional custody
must be completed by the original source/platform custodians before activation.
The 429 email and 434 correspondence registries and permissions are unchanged.

Original Grant may inspect with his own identity. Derivation requires actual verified
sender evidence and complete human review; Tess alone may accept/reserve a separately
valid prospective authority. Neither builder creates those production records. No
second customer approval, ordinary-draft retrofit, alias merge or provider replay is
introduced by this release.

## BUILD437 — original payload and human-source hash binding

Every new strict authority tuple requires `payloadHash` and `sourceInstructionHash`.
`payloadHash = canonicalSha256(saved.scope.payload)` must match both saved payload
bindings. `sourceInstructionHash` is the existing authenticated
`saved.native.binding.source_hash`, checked against `existing_consumption.source_hash`
and the original direct-message provenance (ID, actor, exact text, original timestamp,
owner and consumption identity). It is not a new plaintext-only hash or historical grant.
Creation and service use reject missing/mismatched proof. `authorityHash` continues to
hash ALL tuple fields except itself and therefore commits these two fields. The wire
domain and explicit bindingHash field selection are unchanged.

The read-only compatibility check found zero production positive dispatch authorities.
No records are rewritten. Older missing-field tuples, if encountered, fail closed.
No migration, approval/draft change or new service/sender authority is introduced.
The [synthetic golden fixture](./build437-golden.json) includes the exact canonical
UTF-8 authority, original snapshot, explicit binding object and expected hashes.

Source436 confirmation `build436-dto-authority-hash-auth-confirmation-v1` specifies:
prepare locator `{schemaVersion,nativeActionId,authorityId,authorityRevision}`;
dispatch `/api/cs/composed-sms/intents/:prepareId/dispatch` locator
`{schemaVersion,nativeClaimId}`. Source generates and durably stores the redemption key.
Required source readback `prepareExpiresAt` and `redeemRequestKey` remain unchanged.
Native authentication is `X-Compose-Registration-Id`, dedicated bearer and dedicated
CF JWT audience/common_name; no arbitrary audience header. Sender/guard adapters and
actual service custody remain separate unavailable dependencies.

## BUILD439 strict source readback alignment

The native parser now requires `prepareExpiresAt` as an ISO datetime and
`redeemRequestKey` as UUID or explicit null. `REDEEMING` requires a nonnull UUID.
Association input `requestKey` is also a UUID, generated and durably retained by the
source. First association still checks the original unexpired prepare and exact key;
GET and replay never renew the persisted entitlement or grant another attempt.

Source438's exact sender constraints are adopted: `senderAccountId` matches
`^AC[0-9a-fA-F]{32}$`; `senderReceiptRevision` is a positive safe integer. No identifier
normalization or persisted authority rewrite occurs. Full authority readback is not
required: native independently recomputes the binding from its protected registration
and immutable authority. All existing required payload/source hashes and domain
algorithms remain unchanged.

[BUILD439 golden vector](./build439-golden.json) supersedes BUILD437's synthetic
non-AC account for current schema tests. Only the synthetic sender account and its
consequent wire/authority/binding digests change; BUILD437's historical file remains.
This is schema alignment only; sender, guard and service trust activation remain
unavailable. Employee steps and agent setup instructions are unchanged.

## BUILD440 current native context and explicit v2

Service-only exact GET `/api/composed-sms/verifier/authorities/:authorityId/current-context?revision=1&actionId=UUID`
uses the existing independent bearer + dedicated CF JWT checks and exact registered
authority/executor bindings. No listing, broad inventory endpoint or customer text is
returned. `compose-sms-current-context/v1` carries registration/action/authority and
business/owner/executor/canonical/contact identities, `contextRevision`,
`scopeEvidenceRevision`, observed/expiry timestamps, `complete:true`, `holds`,
`obligations`, `blockingIds` and `execute:false`. Observation lifetime is at most five
seconds and never extends authority, sender or registration expiry.

Each record is `{kind,id,revision,status,scopeEvidenceId,scopeStatus,blocking}`.
Kinds: decision, instruction, composition, draft, delegation, routine. Arrays sort by
ordinal kind then ID. `revision` is canonical SHA256 of the actual row and applicable
audit/proof rows; it is not an invented sequence/version. Decision completion needs
same-version owner result audit and exact stored delegated provider proof, not a
state label alone. Current authority/draft linkage is structural, not a case alias.
Revoked intent and deleted ordinary drafts remain visible blockers.

`scopeEvidenceRevision` uses domain `compose-sms-scope-evidence/v1`, committing actual
absence: `{adapter:null,records:[{kind,id,scopeEvidenceId:null,scopeStatus}]}`. No
compose-permitted complete source closure/classification adapter exists yet. Different
UUIDs do not prove unrelatedness; all other unfinished unbound records block. Existing
routine scope trust is not reused. Complete native inventory is **not** complete
verified source scope or live execution readiness.

`contextRevision` uses domain `compose-sms-current-context/v1`, committing the durable
native dependency clock, exact protected registration hash, immutable authority hash,
scope revision, complete row/audit projection and actual ACL projection. Migration0132
adds insert/update/delete triggers for native decision, human context, draft,
delegation, obligation, composition, routine scope/trust and ACL dependencies. All
writers through those tables serialize on SQLite. Historical business memberships are
retained prospectively across moves; deleting ordinary drafts retains immutable
unknown coverage. Global change-clock invalidation is conservative, including changes
outside this business. Both internal projection and final response are capped at1MiB,
5,000 combined records; overflow rejects without partial clearance.

New association and source readback use **`native-compose-sms/v2`**, with all existing
strict fields plus required `contextRevision`, `scopeEvidenceRevision`,
`guardManifestHash`. Source persists these before REDEEMING. Native checks the exact
persisted readback and recomputes context in the immediate first-association transaction.
Unknown blockers or any revision drift deny. Existing identical winner lookup returns
no entitlement; post-association clock changes never create another attempt. V1 new
associations deny; historical v1 receipt reconciliation remains supported, without
upgrading stored tuples. Authority tuple/hash and authority GET remain unchanged v1.
Source readback needs no full authority extension. Association response uses its stored
version. No cross-system atomicity is claimed; source still fences REDEEMING/SENDING
and rechecks its own guards before the sole provider call.

`guardManifestSchema` in `composedSmsContext.ts` is the jointly accepted strict
`compose-sms-guards/v1`: seven distinct categories enrollment, lease, material,
suppression, duplicate, holds, local_time. Each supplies actual table/revision fields,
writer IDs/revisions, serialization mechanism/lock order and validation revision.
Runtime/origin, implementation/migration revisions, source registration hash, native
context contract, unchanged wire normalization and recipient-time policy provenance
are committed by `composeHash('compose-sms-guards/v1',manifest)`. Hours are07:00 inclusive
to22:00 exclusive recipient-local; unknown timezone denies. Schema validation does not
prove actual writer coverage. The protected registration must additionally carry the
manifest and an accountable review receipt/hash/time/expiry. No production accepted
manifest or source guard installation is claimed by BUILD440.

Dedicated CF provision and approved protected secret destinations now exist. See
[setup receipt](./setup/provisioned.json) and the deliberately incomplete
[activation plan](./setup/activation-plan.json). The latter is NOT a runtime registry;
no placeholder source principal, source-registration hash or guard acceptance is
installed. Actual token expiry is October28 at00:14:26UTC (earlier than prior cap).
Source installation remains with ae5d6289; issuer/use permission is from a4bc.

## BUILD442 verified service expiry

Protected service registrations require strict `credentialExpiry` (`compose-credential-expiry/v1`): `serviceTokenId` UUID; ISO `serviceTokenExpiresAt`, `custodyExpiresAt`, `bearerExpiresAt`, `readbackExpiresAt`, `verifiedAt`; `verifiedBy` UUID; nonempty `receipt`; SHA256 `receiptHash`. The custodian verifies these facts against the exact enclosing client/audience, bearer hash and readback reference before protected installation. This is protected operator evidence, never bot input or a provider verification performed by the loader. The entire registration, including these facts, remains committed by canonicalSha256(registration); changing evidence invalidates existing registration bindings, never silently upgrades immutable authorities.

Schema rejects registration expiresAt later than any dependency and verification at/after its effective limit. Every runtime check repeats schema validation, rejects future verification, inactive registrations, and now >= earliest expiry. Earlier revocation remains effective. No automatic renewal or receipt/replay entitlement. Guard/sender/authority/prepare expiries still independently narrow the boundary.

Historical provisioned.json expiresAt is the requested cap; requestedExpiresAt explicitly names it. Actual serviceTokenExpiresAt and effectiveExpiresAt are 2026-10-28T00:14:26Z, without renewal. Permission receipt is unchanged. Final registry remains absent pending genuine source/custody acceptance, including bearer/readback expiry evidence. Reader429/434 registries and their hashes are untouched. This correction supplies no scope closure/classification adapter or current sender proof.
