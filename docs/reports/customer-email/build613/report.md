# Native customer-email prebind addition — build613

Completed staged native implementation in the verified Veneer checkout, continuing the original repair chat89a543e5-1ae0-455d-b670-913a9e1f6663. Active queue receipt: **Veneer613 running**; ERVP612 was running independently. No duplicate queue/handoff or requeue of597 occurred. Accepted60523aed34 and rejected44a7050 audit remain historical evidence. This addition requires its own independent source-lead adoption.

The new dedicated service-authenticated POST `/api/customer-email-direction/verifier/prebind-context` accepts exact original source/owner/executor/draft/version identifiers only. It requires distinct service CF/bearer/custody, actual enrolled business/current ACL and a separately owner-reviewed explicit prebind capability. It resolves the unchanged full draft and complete605 inventory natively, exports context/ACL/inventory hashes plus bounded retained structured locator provenance, and returns no native human transcripts or execution authority. Old enrollment does not acquire this access implicitly. Exact registration is checked again after asynchronous CF authentication; the native read is atomic and rechecks registration/freshness before returning.

Structured locators support retained native record links, decision/delegation case references, all-version composed-SMS case roots, customer-email case/customer/order roots and routine source-proof case roots. Descriptive tickets/customers, unsupported references and unstructured records remain unknown. Every locator requires genuine authenticated source closure; even a successful native read remains `scope_complete:false`, `ready:false`, `execute:false`, `authority:false`, `dispatchEntitlement:false`. Context/media/cap/identity drift fails. Competing inventory media also blocks this read without an accepted byte-review manifest; no broad private text/media fallback is introduced. Original bot APIs do not expose internal locator rows. Existing service context/association collection now uses explicit service custody without fabricating a bot actor.

605 permanent original action/source/draft/idempotency/UNKNOWN fences, bidirectional vendor/ordinary/routine guards, one-shot service association/readback, sourceMaterial/full semantic renewal pins and own-creation transition remain unchanged. Source freshness remains <=15seconds, post-read <=5seconds. The prebind read envelope is independently capped at5seconds and earliest custody/capability expiry. No applied migration was changed or new table required: existing immutable enrollment evidence/hash binds the exact optional capability manifest.

## Frozen evidence

| Pin | SHA256 |
| --- | --- |
| Dedicated prebind contract | `498349582e0a5dacc7b4daa18e0bf7163ed698a960dbc0867b35ed60e4cbf948` |
| Unchanged dispatchv2 contract | `5e0aa36d9ee697073a50f0390ed5a8fc95eaa8913318f46bc28dd59af5158d01` |
| Ordered native source artifact | `1d6a150241b1ee58c23333e734ed8bf9765cca987bccdecff06caaabc977f00e` |
| Exact combined wire file | `3a1b60807126e587ed8122193efc178842ab2bd80c0d92a3b6cf8dbf2dbf12b4` |

The [contract](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/contract.md) specifies route, capability, locator limits and owner/source dependencies. [Strict wire schemas](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/wire-contract.json), [ordered source manifest](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/artifact-manifest.json), and [pins](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/pins.json) were generated from actual source. Earlier candidate pins were explicitly replaced on existing coordination8f733181-154b-4a5f-a43d-a12fd8b1e770 before final adoption. Lead2d1d47a2-f3a9-4e15-9ff7-96e678fb39c6 retains source consumer, genuine closure producer/all-writer acceptance and end-to-end follow-through.

## Validation

Node24.21.0 with Vitest worker maxima2/minima1. All checks use synthetic fixtures; no live customer/source inspection, claim, send or real authority creation.

- [Server/web typecheck](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/typecheck.txt): passed.
- [Targeted tests](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/targeted-tests.txt):240 passed (167customer-email,40vendor,33feature-guide). Covers dedicated auth/registration/principal/business/current ACL/custody, exact source/draft/version/account/capability scope, extra-key denial, result-reply provenance, complete inventory/revisions, competing authority/revocation, media/chronology/missing source/anchor/caps, structured unknown locator limits, data minimization/nonmutation, fresh read expiry and clock drift; existing605 fences/renewal/one-shot paths remain covered. Full/restricted employee guide and fresh/resumed agent guidance passed.
- [Full root tests](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/full-tests.txt): installer29, server3670+15skipped/278files, web1008/144files, browser51 passed. After the final additional clock/media guard regressions, the entire server suite was rerun on final source, as recorded below.
- [Final full server tests](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/final-server-tests.txt): 3672 passed +15 existing skips across278files; final source, exit0.
- [Root build](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build613/build.txt): passed, exit0. Existing Vite chunk-size warnings remain.

## Changed code

- [customerEmailPrebind.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailPrebind.ts): dedicated strict response/wire schemas, minimized locator projection, capability/freshness checks and atomic native read.
- [customerEmailContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailContract.ts): optional explicit strict prebind capability in protected registration; dispatchv2 schemas retain their meaning.
- [customerEmailNative.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailNative.ts): explicit registered service custody collection, internal locator rows and ACL digest; bot output excludes private locator rows.
- [customerEmailRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailRoutes.ts): exact-registration service auth recheck and new strict read-only route.
- [customerEmailTrust.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailTrust.ts): participant-scope validation and explicit human technical-manifest guidance.
- [customerEmail.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmail.ts): removes manufactured original-bot actor from existing dedicated service context/capture collection.
- [customerEmailArtifact.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailArtifact.ts): new ordered source artifact pin and file list.
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts): staged capability, employee steps, access/setup limits, dated announcement and resumed-agent instructions.
- [customerEmail.test.ts](/Users/archerclawdington/veneer-os/server/test/customerEmail.test.ts): synthetic native/service route regression coverage.

## Concrete remaining dependencies

No indispensable owner decision prevented staging this artifact. Production use remains separate:

1. Nick must expressly authorize **this exact tested native commit's installation/restart**. Native was not installed/restarted, and existing staged0152/0153 migration application is not assumed. ERVP deploy permission grants none of this.
2. Actual source/native custodians must configure the distinct dedicated service CF audience/client/bearer and protected original Sage/Grant/service credentials, accepted source/native artifact pins and real custody/acceptance receipts. Nick/the actual authenticated platform/business owner must review and confirm the new exact prebind capability manifest through human-only enrollment. Old immutable registration cannot silently be amended; a separately reviewed technical registration must never replace an uncertain original action/key.
3. The source lead must independently accept the frozen new native wire/artifact, adopt its service reader and actual retained-reference/revision/closure producer, and verify all source writer guards. Source607 initial() still deliberately denies PREBIND_NATIVE_CONTEXT_UNAVAILABLE until source adoption; native staging is not production initial-reader availability.
4. Original Grant/source custodian must obtain genuine canonical case/current owner/lease and persisted case-customer-order linkage. Customer c9d5e12e-68bf-4e4c-a149-26a5c74b579c is known; missing case/linkage remains unresolved. No case was provisioned, created, guessed or relinked. Shopify18932788363416 remains an ORDER ID.
5. Original Sage must perform actual complete semantic direction review with fresh own-reader material; original Grant must freshly read his unchanged draft/source evidence and accept/reserve. Only the first authenticated accepted dedicated source association entitles one durably fenced attempt. Exact provider acceptance readback does not establish delivery or permit another send.

No restart/install/enrollment/activation/source consumer edits/trust configuration/live tests/customer effects, purchase/money/order/address edits or hold release occurred. Original Grant retains future email/reply/new-address-on-file, Sage purchasing, and Addresshold stays. Unrelated untracked `.veneer-browser/`, `.veneer/` and `out/` remain preserved. Staged code is not customer-send ready.
