# Integrated correction continuation — native offer, not deployed or jointly accepted

This artifact scopes one native continuation of BUILD450/451 and one conditional source integration. It creates no authority, customer action, custody amendment or build. Grant's existing full-context assessment is retained; do not request it again. The service offer below must be accepted by source before coupling. Historical schemas remain unchanged.

## Integrated owner workflow

Add explicit correction-v2 inspect/derive APIs rather than change the meaning of existing recorded correction-v1 proofs. Inputs retain BUILD450's exact decision/version, historical source, correction ID/kind, original lineage draft, corrected draft/version, executor and both case IDs. Inspection returns current complete native context, all later human messages and both the native-preflight and complete composition inspection hashes. Native-only preflight remains available without a draft/source read.

Derive takes the complete BUILD451 review INPUT (not its returned reviewer object or detached review_hash) plus the exact corrected-payload review. Server runs the existing authenticated preflight snapshot/review validation again as the actual owner, requires direction_retained_for_semantic_review, and requires exact agreement of decision, original source and correction identifiers with composition inputs. It validates every later-human citation exactly once. Substantive supersession/ambiguity denies; status-only is neither permission nor automatic supersession. No keyword classification.

The owner supplies complete authenticated citations for the original continuing compose/send direction, the narrowing correction, channel and recipient, plus a reasoned continuity explanation. Every cited instruction author must currently have authority; citations cannot come from bot text or quoted imports. This replaces correction-v1's requirement that the correction alone repeat a send command. A wording edit without an independently established continuing send direction still denies. Historical consumption is provenance, not the new grant. Native full-context semantic assessment is accountable owner review, not an automatic consequence of a narrative, hash or status question.

Re-run native author/owner/executor access, full context, decision version/handling/proposal/state, both draft scopes, duplicate/revocation and payload checks after source reads and again inside the immediate recording transaction. The re-read must match both review and composition hashes. Persist complete assessment, citations and hashes with a new immutable correction-v2 authority. No v5/v6 answer, consumption, old draft or prior authority is rewritten. Accept, claim, export and first association revalidate the same native proof/context dependencies; new context requires new review, never silent reuse or replacement of an already reserved action. No business execution is part of this build.

Grant owns the exact desired SMS instruction/scope review. Tess, using her own supported draft-save API, prepares ONE separate ordinary corrected SMS draft, without decision binding, authorization or claim. Preserve old stale draft and copy no email-v6 authorization. Preserve the original SMS account/recipient/customer/ticket/channel/executor; only the intended body changes. First reconcile an equivalent corrected draft to avoid duplicates. Grant then binds its actual returned ID/version/hash in correction-v2 inspection. No builder creates or modifies this business draft. The absence of that exact draft is not missing human consent; it is an uncompleted executor preparation step.

## Strict source-facing authority

Version literal V = native-compose-sms-correction-dispatch/v1. All objects strict; no unknown keys. UUID is canonical lowercase UUID; Hash is lowercase 64hex; ISO is UTC milliseconds; revision values are safe integers. P is positive, N nonnegative. Runtime is {projectId:UUID,environmentId:UUID,serviceId:UUID}. Existing wire validation is retained: AC plus 32 hex account, canonical E164 phones, valid UTF8 body length 1..1600, media exactly [], normalizationPolicy sms-identity-utf8/v1.

Authority A has EXACTLY these keys:

```
nativeActionId: UUID
authorityId: UUID
authorityRevision: 1
proofKind: 'native-compose-sms-correction/v2'
correctionAuthorityHash: Hash
correctionSourceKind: 'direct_message'|'result_reply'
correctionSourceId: UUID
correctionSourceHash: Hash
contextHash: Hash
decisionId: UUID
decisionVersion: P
decisionProposalHash: Hash
decisionHandlingRevision: N
nativeBindingHash: Hash
reviewHash: Hash
originalActionDigest: Hash
lineageHash: Hash
payloadHash: Hash
scopeHash: Hash
materialHash: Hash
materialHashVersion: 'compose-correspondence-material/v1'
businessId: UUID
sourceOrigin: pinned registered HTTPS origin
runtime: Runtime
ownerConversationId: UUID
executorConversationId: UUID
executorPrincipalId: 'veneer:' + UUID
canonicalCaseId: UUID
canonicalTicket: nonempty string <=200
contactCaseId: UUID
contactTicket: nonempty string <=200
senderReceiptId: UUID
senderReceiptRevision: P
senderAccountId: actual AC identifier
fromPhone: E164
toPhone: E164
wireBody: exact string
media: []
normalizationPolicy: 'sms-identity-utf8/v1'
wirePayloadHash: Hash
idempotencyKey: 'veneer-compose-sms:' + nativeActionId
derivedAt: ISO
authorityExpiresAt: ISO
authorityHash: Hash
```

No correction text, sourceInstructionId/sourceInstructionHash, historicalConsumptionHash, human quotations, result anchors or review prose are exported. CorrectionSourceHash is SHA256 canonical JSON of the authenticated correction object retained natively, not an invented consumption hash. Source cannot reconstruct private text; the newly accepted registered verifier authenticates that commitment. NativeBindingHash commits the current native composition binding, reviewHash the full validated original-owner assessment. CorrectionAuthorityHash commits the complete immutable private correction-v2 authority (excluding its own hash) under native-compose-sms/correction-authority/v2. A current native check must validate all those commitments before export.

ScopeHash = H(native-compose-sms/correction-scope/v1, {businessId,ownerConversationId,executorConversationId,executorPrincipalId,canonicalCaseId,canonicalTicket,contactCaseId,contactTicket,payloadHash,wirePayloadHash}). Full payloadHash uses the existing saved-payload canonical SHA256, distinct from wirePayloadHash. No change to payload normalization is introduced.

## Authenticated original-action lineage

L = {schemaVersion:'native-compose-sms-action-lineage/v1',nativeIssuer,businessId,decisionId,channel:'sms',originalActionDigest,nativeActionId}, with nativeIssuer the protected native HTTPS origin. originalActionDigest = SHA256 canonical JSON({business_id:businessId,decision_id:decisionId,channel:'sms'}). lineageHash = H(native-compose-sms/action-lineage/v1,L).

Native atomically resolves one durable dispatch UUID for this digest across historical and correction paths. Existing action UUID wins; a different correction cannot replace an existing authority/action or UNKNOWN. No digest reinterpretation. The same authenticated export envelope carries L; source independently recomputes digest/hash and cross-checks all shared values against A and its pinned issuer.

Source adds durable uniqueness on (nativeIssuer,businessId,originalActionDigest), in addition to existing action/idempotency uniqueness, shared across proof versions. Historical rows lacking verified lineage cannot be assumed unrelated. Before accepting a correction for a business with such rows, source obtains exact-ID historical lineage from a separately agreed verifier endpoint (GET /api/composed-sms/verifier/actions/:actionId/lineage) under the same registered service identity. Its envelope is {schemaVersion:'native-compose-sms-action-lineage/v1',registrationId,registrationRevision,sourceRegistrationHash,lineage:L,observedAt,expiresAt,execute:false}. Native binds historical lineage directly to durable native action/authority records; absent records deny. Never backfill from caller JSON, ticket/body similarity or draft IDs. No historical lineage changes the old authority/hash. An unresolved historical row blocks correction acceptance until reconciled. Source adoption must preserve conflicts rather than discard or remap them.

## Exact DTOs and routes

New native export GET /api/composed-sms/verifier/correction-authorities/:authorityId?revision=1&actionId=UUID. Envelope = {schemaVersion:V,registrationId:UUID,registrationRevision:P,sourceRegistrationHash:Hash,authority:A,lineage:L,observedAt:ISO,expiresAt:ISO,execute:false}. Expiry is min(observedAt+15s, durable authority expiry, sender expiry, all applicable service/token/custody expiries). Never renew durable expiry.

Source POST /api/cs/composed-sms/intents request = {schemaVersion:V,nativeActionId:UUID,authorityId:UUID,authorityRevision:1}. Response = {schemaVersion:V,prepareId:UUID,nativeActionId:UUID,bindingHash:Hash,state:'PREPARED',observedAt:ISO,prepareExpiresAt:ISO,execute:false}. Named Tess supplies locators only; source fetches authority/lineage itself. Replay retains original prepare expiry and returns actual persisted state through readback, never claims PREPARED after advancement.

Source POST /api/cs/composed-sms/intents/:prepareId/dispatch request = {schemaVersion:V,nativeClaimId:UUID}. Source generates durable redemption key. Native association input has EXACT fields {schemaVersion:V,nativeActionId,authorityId,authorityRevision:1,nativeClaimId,sourcePrepareId,bindingHash,requestKey,contextRevision,scopeEvidenceRevision,guardManifestHash}; IDs UUID, hashes Hash. Use existing registered dispatch-association route with explicit new-version allowlist, no fallback. Native context remains current-context/v2 only after its implementation understands this new authority proof; no direct reuse of the old consumption reader.

Association response = {schemaVersion:V,associationId:UUID,nativeActionId:UUID,nativeClaimId:UUID,sourcePrepareId:UUID,bindingHash:Hash,state:'ASSOCIATED'|'REVOKED',dispatchEntitlement:boolean,execute:false,issuedAt:ISO,expiresAt:ISO}. Only the first authenticated association can return entitlement; repeated/lost response never grants it again.

Source dispatch response and GET /api/cs/composed-sms/actions/:nativeActionId readback use EXACT sourceReadbackV3Schema fields with schemaVersion V: nativeActionId,prepareId,bindingHash,nativeClaimId(nullable),associationId(nullable),attemptId(nullable),state,authorityHash,wirePayloadHash,idempotencyKey,providerReceipt(nullable),observedAt,prepareExpiresAt,redeemRequestKey(nullable),execute:false,contextRevision,scopeEvidenceRevision,guardManifestHash. Existing strict field types, state enum and providerReceipt schema are unchanged. REDEEMING requires nonnull exact durable redemption UUID; prepareExpiresAt is original persisted expiry. Readback itself never sends or repairs timelines. Native recomputes binding from its authenticated authority and registered source identity, not bot-provided proof.

## Hash domains and attempt ordering

H(domain,value) = SHA256 UTF8 canonical JSON({domain,value}); recursive JS ordinal key sorting, array order preserved, no whitespace, explicit nulls; no Unicode normalization. Source parses strict DTO before hashing.

authorityHash = H(native-compose-sms/correction-dispatch-authority/v1,A excluding authorityHash). Wire hash retains H(native-compose-sms/wire/v1, {senderAccountId,fromPhone,toPhone,wireBody,media,normalizationPolicy}).

bindingHash = H(native-compose-sms/correction-dispatch-binding/v1, EXACT {registrationId,registrationRevision,sourceRegistrationHash,nativeActionId,authorityId,authorityRevision,authorityHash,proofKind,originalActionDigest,lineageHash,scopeHash,materialHash,senderReceiptId,senderReceiptRevision,wirePayloadHash,executorConversationId,executorPrincipalId,canonicalCaseId,canonicalTicket,contactCaseId,contactTicket,idempotencyKey}). Values from protected registration and A only. AuthorityHash transitively commits every correction/context/current-revision field.

Source durable intent/action-binding audit precedes current-context queries; immutable REDEEMING/requestKey CAS precedes native permit association; final guarded committed SENDING precedes the sole provider invocation. Both systems enforce same-action immutability and current revision/authority revocation. UNKNOWN/expired/revoked states never release uniqueness or allow a new key/draft retry. Provider acceptance differs from delivery. Existing source writer locks, exact wire fence, sender-process, source closure and timezone gates remain, not replaced by DTO fields.

## Custody and ownership

Native owner Platform Dev: integrated correction-v2 review/derive, versioned export/current-context/accept/claim/association/readback verification and historical lineage endpoint; no business effects by builder. Source owner ae5d: assess this contract, then only agreed parser/ledger/lineage migration/prepare/dispatch/readback changes in one source job. Original custodian: explicit amendment for hashes-only correction proof, exact new correction-authority and historical-lineage GETs, new version on existing association/readback routes, and required immutable audit writes. No inherited route permission or silent registration-preimage mutation; agree a separately versioned ACL/acceptance amendment or new registration revision. Same actual service/executor/caller bindings and earliest expiry; no new secret or broad access implied.

Do not queue source until schema/lineage adoption/custody amendment are agreed. BUILD451 review alone is not a grant; actual corrected SMS draft still absent. Sender receipt expired, actual process/scope/timezone remain unresolved. No refresh is commissioned. Synthetic golden.json proves only the listed canonicalization/hash arithmetic; its private-proof commitments are synthetic, not authenticated evidence, and it is not an implemented parser or readiness test.
