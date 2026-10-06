# Corrected staged native customer-email repair — build 605

October 6, 2026. Implemented all four corrective areas in the active **Veneer #605** slot, original repair chat `89a543e5-1ae0-455d-b670-913a9e1f6663`, checkout `/Users/archerclawdington/veneer-os`. This is source correction of rejected `44a7050`, not a documentation-only continuation. **Staged, not installed/enrolled/activated or customer-send ready.** No native restart, source coupling or customer effects occurred. Original ERVP #597 was not requeued; lead retains separate source consumer/end-to-end acceptance.

Fresh queue receipt before edits: `Veneer 1. #605 [running] Continue #599: correct customer-email fences, inventory and review renewal`; ERVP #598 running / #601 queued. Continued the same repair, no new handoff or duplicate queue entry, no timer. Read current native guidance, lead build597 rejection report and build599 report/contract before changes. Source scope remained native-only and synthetic.

## Corrected behavior and evidence

| Area | Correction | Synthetic evidence |
|---|---|---|
| Vendor/ordinary serialization | Immediate vendor bind AND claim check customer overlap; migration0153 independently fences immutable vendor insertion, claimed event, target update, reverse customer bind/consume, and ordinary/delegated/routine draft updates/inserts. Original source collision persists after success. | Customer-first vendor bind/legacy claim fail; vendor bound/claimed/UNKNOWN-first customer inspection fails. Vendor authority/target/source insert failures roll back all fences; event/target claim failures roll back consumption while existing authority keeps competitor blocked. Native bind/association/receipt-save failures produce no entitlement or false overlap release. |
| Permanent originals / temporary overlap | Action fence identifies original human action, not all contact about one order. Original source/action/draft/key/intent/idempotency and UNKNOWN audit are permanent. Only saved authenticated exact SENT_ACCEPTED releases recipient/order overlap. | UNKNOWN→accepted retains both audits; original draft/key/source/reassociation cannot replay. Separate new source/new draft binds and reserves for same recipient/order; separate ordinary reply can claim. Bound/UNKNOWN/NO_EFFECT/revoked/expired holds and receipt-save loss remain blocking. |
| Complete inventory | Full customer authority/audit/enrollment, every SMS proof version/lineage/dispatch/association/receipt/scope/revocation, vendor target/source fences and routine dispatch are inventoried. Only exact own internal lifecycle bookkeeping is stable; own authority/revocation and competitors stay visible. | Exact own accepted/reserved/association/receipt bookkeeping leaves its current revision stable; own revocation drifts. Every competing customer lifecycle step and individual SMS surface changes hash and invalidates review. Full original-row integrity and own postaccept closure/relation drift fail. New SMS/customer/scope rows inserted during source capture read fail fresh native comparison before acceptance. |
| Practical semantic renewal | Strict v2 inspection pin separates immutable semantic material from authenticated fresh capture/read envelope. New own capture + reinspection + identical hashes allows same full accountable review. No old capture renewal or uncertain-bind retry. | Clock advances two minutes; new UUID/observation/expiry/snapshot with identical reviewed material succeeds. Material/identity/scope/fence/lease/sourceMaterial/closure/relation/coverage/context/ACL/payload/registration drift fails. Exact production <=5s monotonic post-read bound tested; <=15s source freshness remains unchanged. |

The expanded matrix additionally exercises **actual ordinary, delegated and routine services**: customer-first claims deny atomically and roll back internal routine claim/delegation claimed-event writes; reverse claimed and reverse queued authorization states prevent customer authority insertion. The customer-first service matrix runs at bound authority, associated intent and saved UNKNOWN. Capture-read races run during both acceptance and claim; an awaited intent-read race prevents association entirely, with zero persisted entitlement. Both structured prior-return and prior-SMS canonical overlaps reject reverse customer bind. All fixtures use isolated in-memory migrated SQLite, synthetic identities/principals/source assertions and example.test recipients. No actual customer/provider transport or authority was exercised.

## Exact artifact and checks

Projection `customer-email-direction-dispatch/v2`, capture `customer-email-capture/v2`, unchanged strict intent `customer-email-intent/v1`. See [corrected contract](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/contract.md), [strict API/proof wire schemas](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/wire-contract.json), and [native artifact/file manifest](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/artifact-manifest.json).

- Contract SHA-256: `5e0aa36d9ee697073a50f0390ed5a8fc95eaa8913318f46bc28dd59af5158d01`.
- Native artifact SHA-256: `b287f1117c163330747729f2c5671bbaea41870f0a349afe9140f733e9fbb26d`.
- Wire file SHA-256: `875780e8875b964203eb1a088baa38396243fe3fca22acb7fbca8c7ebe8bba8b`.

Final check receipts (the final complete server rerun includes the last expanded tests):

- [Server + web typecheck](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/typecheck.txt): `npm run typecheck` passed using Node24.21.0.
- [Targeted tests](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/targeted-tests.txt): 139 customer-email +40 vendor +32 guide = **211 passed**. Employee guide access and full/restricted fresh/resumed agent instructions include corrected staged scope/setup limits; no installed UI readiness claimed.
- [Full required repository tests](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/full-tests.txt): root full run passed: installer29, server3575 passed/15 skipped (277 files), web1008 (144 files), browser51. [Final complete server rerun](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/final-server-tests.txt) includes all last matrix tests: **3587 passed/15 skipped, 277 files**.
- [Server + web build](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/build.txt): `npm run build` passed after all required tests, with existing Vite large-chunk warnings. Build only; no root restart/install command.

Known Node24 path `/opt/homebrew/opt/node@24/bin`, with bounded Vitest workers `VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1`. No dependencies changed. Native artifact regression recomputes actual ordered source file hashes; historical migration0152 is unchanged. New migration0153 is copied by server build but remains unapplied by this task.

## Changed code and review surfaces

- [Native authority/service](/Users/archerclawdington/veneer-os/server/src/bots/customerEmail.ts): original action fencing, creation integrity/full acceptance pin, atomic consume and semantic continuity.
- [Strict v2 schemas](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailContract.ts): corrected projection/capture, completed-action relation and full bot API manifest.
- [Authenticated reader/freshness/material pins](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailIO.ts).
- [Complete native inventory](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailNative.ts).
- [Exact artifact constants/files](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailArtifact.ts).
- [Vendor bidirectional service guards](/Users/archerclawdington/veneer-os/server/src/bots/vendorEmail.ts).
- [New append-only migration0153](/Users/archerclawdington/veneer-os/server/src/db/migrations/0153_customer_email_corrections.sql).
- [Strict MCP tooling/guidance](/Users/archerclawdington/veneer-os/server/src/mcp/customerEmailTools.ts).
- [Employee and resumed-agent feature guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts).
- [Customer-email/matrix regression tests](/Users/archerclawdington/veneer-os/server/test/customerEmail.test.ts) and [vendor regression tests](/Users/archerclawdington/veneer-os/server/test/vendorEmail.test.ts).

All newly created artifacts are linked above or in this report's [contract](/Users/archerclawdington/veneer-os/docs/reports/customer-email/build605/contract.md). Unrelated `.veneer-browser/`, `.veneer/` and `out/` remain untouched/untracked. Explicit paths are committed and pushed; no broad git add.

## Limits and concrete owner dependencies

No indispensable human decision prevents **staging** these corrections; implementation and synthetic verification are commissioned. Actual usage remains gated:

1. **Lead ERVP Platform Dev** independently accepts the corrected exact v2 pins/commit and implements/validates its source producer/consumer, dedicated service, persisted intent/readback and shared all-channel guards under its own queue. Interim schema messages or passing native fixture counts are not source adoption. Final results are sent via original coordination `8f733181-154b-4a5f-a43d-a12fd8b1e770`; lead retains coupling/end-to-end follow-through.
2. **Original Grant** retains genuine canonical customer `c9d5e12e-68bf-4e4c-a149-26a5c74b579c`; ShopifycustomerId is null. Order100122404 / `bc7ebcc5-02c0-451b-9641-410ccda5e863` / Shopify18932788363416 (ORDER ID) has exhausted original order/email/relatedOrderId conversation searches. Canonical case, current case owner and persisted case/customer/order linkage remain unresolved. Grant must obtain genuine source evidence through his own connection. No case creation/mapping/relink is commissioned; descriptive native ticket/customer is not identity. No duplicate business consent.
3. **Nick, actual native platform owner**, must later explicitly authorize installation/restart of the exact tested correction commit and pins. ERVP permission cannot grant it. A separately authorized root build/restart applies migration0153 and loads v2; existing browser preservation remains respected. No such authorization is requested or exercised during this staging task.
4. **Actual native/business owner + source custodian**, after accepted source and canonical scope exist, supply protected dedicated registry/custody: distinct original Sage/Grant/service principal/credential references, connected account/runtime, dedicated CF audience/client/bearer hash, source/native/contract/guard artifacts, custody/adoption receipts and unexpired readback/credential/lease bounds. Actual human owner alone reviews enrollment prepare/confirm; no builder/borrowed session or reused vendor/SMS/routine/return trust.
5. **Original Sage then Grant** perform actual full semantic review/binding and fresh own-current-draft/source acceptance/reservation; only FIRST accepted dedicated source association may dispatch its one durable intent. Read-only exact original reconciliation handles response/save loss; no retry entitlement. Authentic source media/full scope closure must exist; omitted media/unknown coverage remain blockers.

The supported review-renewal route is bounded by unchanged live reviewed lease/custody and immutable sourceMaterial/record closure. New lease/ACL/payload/context/material/closure means new review, never a freshness shortcut. Complete inventory does not prove unrelatedness; native does not infer aliases, certify source lock adoption or unblock legacy SMS/vendor/ordinary/return uncertainty. The explicit own-creation transition is integrity-verified and then fully pinned by Grant acceptance; it is not a blanket authority exemption.

Original Sage source/direction, Grant executor/principal, exact unchanged draft v1/null ordinary authorization, retired billing audit, withdrawn purchase decision and all business approvals remain intact. Grant retains send/reply/new-address-on-file; Sage retains purchasing; Addresshold stays. Provider acceptance is not delivery/address verification. No purchase, money, order/address edit, hold release, live customer test/claim/send, restart/enrollment/automatic activation or source coupling occurred.
