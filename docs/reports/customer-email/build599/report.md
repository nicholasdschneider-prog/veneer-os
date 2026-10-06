# Staged native Grant customer-email repair — build 599

October 6, 2026. **Native implementation staged; not installed, enabled or customer-send ready.** Native queue #599 was deduplicated separately from ERVP #597, which was not requeued. Work began only after the native slot became active. The ERVP lead remains `2d1d47a2-f3a9-4e15-9ff7-96e678fb39c6`; progress and the frozen native contract were sent through original coordination `8f733181-154b-4a5f-a43d-a12fd8b1e770`.

Implemented a decision-independent bounded original-human context reader and prospective customer-email semantic binding, immutable source/executor/draft/full-payload authority, original Grant-only acceptance/reservation, separate actual-owner technical enrollment, authenticated dedicated service association and exact readback. A bot always receives `execute:false`. Only a first durably committed service association returns `dispatchEntitlement:true`; replay/lookups never reproduce it. UNKNOWN, failed persistence, expiry and revocation retain permanent source/action/recipient fences. Real provider acceptance is separate from delivery.

This build does not inspect/bind the actual Sage source, claim the actual Grant draft, query a customer's mailbox, enroll, restart, send, create/relink a canonical case, answer/reopen the withdrawn purchase decision, edit an order/address, release a hold or activate a source. All authority/dispatch tests use an in-memory migrated database and synthetic identities/material/provider receipts. Actual source dispatch/pre-provider durability is an explicit ERVP acceptance dependency, not something proved by native fixture IO.

## Exact contract and follow-through

See [frozen API, projection and concrete installation/setup dependencies](./contract.md), [machine wire schemas](./wire-contract.json) and [artifact manifest](./artifact-manifest.json). The actual native artifact and wire hashes were sent to the lead for explicit source adoption before coupling; no lead acceptance is invented.

Nick must separately authorize native install/restart of this tested artifact. The ERVP lead must supply accepted source capture/intent/dispatch producers and guard/registration/artifact hashes, with real dedicated service/reader custody. Grant must independently establish genuine canonical case/customer/order and exact current own draft. The actual owner must review and confirm the dedicated protected registration through the human-only prepare/confirm API. Sage's genuine semantic review and Grant's fresh acceptance/reservation remain runtime steps. Staging does not make this particular case eligible.

Native context returns explicit unreviewed media and does not accept a bot assertion of byte review. Incomplete or undocumented source/native inventory closure remains blocked. Source scope/shared writer coverage is not certified by these synthetic tests. The original draft, ordinary authorization, retired audit and withdrawn purchase record are preserved; native migration guards cover structured return/SMS overlaps and ordinary/routine/delegated email claim races.

## Validation

- `npm run typecheck`: passed for server and web with installed Node 24.21.0. The default shell Node has a missing Homebrew dylib; no runtime/dependency installation was performed.
- Full `npm test`: **passed** with `VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1`. Installer **29/29**; server **277 files, 3,505 passed / 15 skipped**; web **144 files, 1,008 passed**; browser manager **51/51**. Two default-concurrency runs hit the existing Codex afterEach `ENOTEMPTY` cleanup race. The isolated Codex suite passed **59/59**; reducing concurrent workers allowed every suite to pass without changing Codex/runner code.
- Final native/related scoped run after the conservative same-second chronology guard: **142/142**, including **58 customer-email tests**, vendor email, ordinary communication and full/restricted employee plus fresh/resumed guide delivery. The full-suite server count above preceded this last additional chronology regression; the final scoped receipt covers the final native source/artifact.
- `npm run build`: **passed** for server and web. Vite reported its existing large-chunk advisory. No native restart followed; migration 0152 and registry/enrollment remain uninstalled.
- `git diff --check`: passed. Unrelated `.veneer-browser/`, `.veneer/` and `out/` preserved. No actual customer or source authority was exercised.

Synthetic tests cover source-owner/executor/human/builder restrictions; genuine direct/result source and complete retained anchors; later direct/shared voice/native human event coverage; withdrawn purchasing independence; unchanged full draft and retirement audit; byte/span/citation review; capped/missing media and chronology; source identity/custody/runtime/lease/context/registration drift; unknown/overlapping inventory coverage; shared ordinary/return/SMS fences and competing binds; original-key replay/lookup; bot reservations; durable first-association failure/lost response; authenticated provider acceptance; UNKNOWN/NO_EFFECT and receipt-save loss without resend. Source pre-provider execution/timeout evidence is modeled as authenticated synthetic intent readback: this does not validate or accept a real ERVP dispatch implementation.

Retained verification receipts:

- [typecheck.txt](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/typecheck.txt)
- [full-tests.txt](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/full-tests.txt)
- [targeted-tests.txt](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/targeted-tests.txt)
- [codex-recheck.txt](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/codex-recheck.txt)
- [build.txt](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/build.txt)

## Changed files

Native implementation:

- [customerEmail.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmail.ts)
- [customerEmailNative.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailNative.ts)
- [customerEmailContract.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailContract.ts)
- [customerEmailIO.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailIO.ts)
- [customerEmailTrust.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailTrust.ts)
- [customerEmailRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailRoutes.ts)
- [customerEmailArtifact.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailArtifact.ts)
- [0152_customer_email_direction.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0152_customer_email_direction.sql)

Wiring, configuration and employee/resumed-agent guidance:

- [customerEmailTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/customerEmailTools.ts)
- [botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [communicationRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [config.ts](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [index.ts](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [customerEmail.test.ts](/Users/archerclawdington/veneer-os/server/test/customerEmail.test.ts)

Retained review artifacts:

- [contract.md](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/contract.md)
- [wire-contract.json](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/wire-contract.json)
- [artifact-manifest.json](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/artifact-manifest.json)
- [report.md](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build599/report.md)
