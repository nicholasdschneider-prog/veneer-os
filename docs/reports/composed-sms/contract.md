# Composed SMS evidence and prospective authority

September 28, 2026. BUILD432 continues BUILD431. Native code does not enable live SMS by itself.

The original source-owning bot uses `inspect_composed_sms` with exact `source_id`, `draft_id`, `expected_draft_version`, `executor_conversation_id`, `canonical_case`, and `contact_case`. The server verifies original authenticated human source and immutable email consumption, current native access, original proposal and exact ordinary SMS draft. It reads the full bounded native context and directly fetches authenticated source correspondence. Neither uploaded JSON nor bot-provided equivalence assertions are accepted as source proof.

## Source interface and custody

Fixed source origin: `https://orderops-dev-web-production.up.railway.app`. Exact read sequence:

1. `GET /api/cs/approved-case/capabilities`
2. `GET /api/cs/approved-case/correspondence/:canonicalUuid/:contactUuid`
3. `GET /api/cs/approved-case/capabilities`

No queries, redirects, broad case fallback, token forwarding to another origin or identity borrowing. Each actual owner/executor uses its own registered credential at use time. No live credentials are read by BUILD432.

Separate `VP_COMPOSE_CORRESPONDENCE_REGISTRY_FILE` is required. It is an absolute, non-symlink, service-user-owned regular file with mode0600 and maximum128KiB. Its strict schema is `correspondenceRegistrySchema` in `server/src/bots/composedSmsReader.ts`: schema_version `compose-correspondence-registry/v1`, registrations carry current business/owner/source account/runtime/origin, caller-to-principal and protected credential references, explicit expiry, and provenance authority `compose-send-correspondence-custody`. A genuine source-custodian receipt extending correspondence/customer-data read custody is necessary; BUILD429's approved-message-resolver registry is rejected. No registry is installed by this release.

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

1. Final source433 deployed contract/receipt and explicit protected correspondence custody extension from original custodian.
2. Authenticated current SMS account/fromPhone ownership evidence with provenance/revision; configured credentials or historic inbound destination are insufficient. Current v1 only emits unknown.
3. Agreed and implemented source-enforced native-action dispatch association, exact wire payload and durable UNKNOWN/readback contract. Current generic manual-SMS route cannot consume a native action grant.

These are technical source prerequisites, not another customer approval. Grant performs the supported original-owner review after those prerequisites; Tess retains eventual separately guarded execution. The builder does not inspect live cases, enroll, create authority or send.
