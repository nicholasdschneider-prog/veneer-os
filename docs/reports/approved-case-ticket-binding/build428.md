# BUILD428 — dedicated approved-case endpoint adoption

September 28, 2026. Continues BUILD425/250. Root typecheck, 118 scoped tests and full npm test passed: 2,686 server tests
(five existing skips), 909 web, 54 browser-manager and 29 installer tests.
Root production build passed (existing Vite large-chunk warning only). Implementation
**6f908d0** was committed and pushed to origin main before detached root restart.
All five services returned HTTP200 at **21:00:37.873Z** on Node24.21.0; all **4,534**
built artifact hashes matched their pre-restart manifest. Public front door302 and four
tunnel edge connections do not prove authenticated chat or customer delivery.
No schema change was needed. Names-only configuration check confirms the native registry
setting remains absent. Live registry activation is separate.

[Nonsecret runtime receipt](./build428-runtime.json).

Native resolver now uses only:

1. `GET /api/cs/approved-case/capabilities`
2. `GET /api/cs/approved-case/conversations/:uuid`
3. The same dedicated capability GET again.

There is no legacy fallback. Existing exact identity/projection validation, fixed origin,
registered principal/account/business/runtime, use-time own-credential binding, response
size, timeout, redirect refusal, freshness, immutable approval/mapping/hash/executor,
one-time claim, UNKNOWN and receipt-only completion rules are unchanged. Equal-ID
clients remain unchanged and need no resolver registration.

Source contract confirmed by reading deployed BUILD426 source/contract and its retained
receipt: f3fe128024607080a0e50f5be7651e045e237650; configuration deployment
4814aa22-fcc0-46c0-9a3f-004975be2e38 SUCCESS, exact health SHA at20:42:36Z.
Dedicated reads use read-only transactions with auth initialization/cache disabled.
Nullable order ID and absent optional binding fields are accepted without inventing data.
No source edits, credential reads, live case/provider actions or customer effects here.

## Remaining activation dependency

Original-custodian coordination 8c3f2513-a025-4b4a-b531-c9cc09bb4e13 reports six
successful own-credential capability checks at20:46–20:48Z, matching source account,
native business and runtime tuple. Miles's written UUID was corrected from his retained
response. Exact protected references and caller associations are established; Henry is
not included. These are timestamped source acceptance receipts, not continuing access
or permission for native-server use.

No existing scoped native-server credential-use permission was found by that bounded
custodian review. Required next action: the rightful credential custodian or authorized
account administrator records permission for the existing native service to retrieve
each original caller's own named reference at use time, solely for this dedicated GET
pair on behalf of that same caller. Record actor/authority, exact service/caller/reference/
route scope and revocation basis. No new customer-send approval or another source API
field is required. Then Platform can install the protected registry; original owners
inspect the unchanged current approved version before any guarded executor action.
No registry installed by this endpoint-adoption release. No borrowed credential or
unbound-draft retrofit; stale Brian v3 remains unusable.

## Files

- [Resolver](/Users/archerclawdington/veneer-os/server/src/bots/approvedCaseResolver.ts)
- [Resolver tests](/Users/archerclawdington/veneer-os/server/test/approvedCaseResolver.test.ts)
- [Catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Guide tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Guide](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Current contract](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/resolver-contract.md)
- [This receipt](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/build428.md)

- [Runtime receipt](/Users/archerclawdington/veneer-os/docs/reports/approved-case-ticket-binding/build428-runtime.json)
