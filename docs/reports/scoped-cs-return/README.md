# BUILD257 — scoped CS context and return verifier

Implemented by existing Platform Dev owner. Production deployment and post-restart results are recorded below after release.

The shared decision repair exposes existing attached context to already-eligible ERVP CS humans without granting mixed-role source conversations. A pre-release read-only check against the native database returned Nicholas **12** and Ali **12** raised hands, with **11** of Ali's cards explicitly limited to decision context. All five source conversations remained denied to Ali. No users, memberships, grants, approvals or proposal versions were changed.

The narrow return producer retains the original Y4DYW5 approval and records a separately attributed, authoritative source mapping. It supports dedicated service authentication, authenticated owner trust enrollment/revocation, one atomic claim per decision, and same-intent uncertainty reconciliation. The original OrderOps owner reviewed all six DTO/recovery corrections and found no further producer incompatibility. No live enrollment/mapping/claim/return or customer action occurred.

[Executable setup and producer/consumer contract](./contract.md) covers exact endpoints, actor requirements, dedicated Cloudflare configuration, capture/fingerprint rules, all six findings, revocation, final remapping and lost-response recovery. Deployment is distinct from configured trust and independent source acceptance. Original OO owner retains its transaction/dispatcher work.

## Validation

- Root typecheck passed.
- Full root tests passed: server 2,311 passed / 5 skipped; web 865; browser manager 40; installer 21.
- Scoped tests cover 11 cards / 5 sources, original proposal preservation, current eligibility, private/foreign sources, immutable mapping/claim/audit, source and identity changes, selected quantity, replay, competing claims across connections, restart readback, authenticated HTTP boundary and source drift.
- UI mock fixtures passed 320/375/414/768/1080/1440/1920, both themes, no horizontal overflow, original image preview/keyboard controls, explicit restricted image state with zero restricted-image requests, and nonlinked restricted source references.
- Full/restricted employee guide browser checks passed; catalog and instruction-context tests verify refreshed/resumed agent discovery.
- Production build result and restart health are recorded in the deployment receipt below.

Hallmark component critique: Philosophy5, Hierarchy4, Execution4, Specificity5, Restraint5, Variety3. Existing tokens/component ownership retained; no redesign or fabricated evidence.

![Restricted image shown honestly on mobile](./gallery-375-dark.png)
![Scoped evidence on desktop](./gallery-1440-light.png)

## Changed source and verification files

- [Decision access service](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [Return verifier service](/Users/archerclawdington/veneer-os/server/src/bots/returnException.ts)
- [Dedicated service routes](/Users/archerclawdington/veneer-os/server/src/bots/returnExceptionRoutes.ts)
- [Human trust routes](/Users/archerclawdington/veneer-os/server/src/bots/communicationRoutes.ts)
- [Immutable bridge migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0115_return_exception_bridge.sql)
- [Runtime configuration](/Users/archerclawdington/veneer-os/server/src/config.ts)
- [Router mount](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [Living catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Decision fixtures](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)
- [Return fixtures](/Users/archerclawdington/veneer-os/server/test/returnException.test.ts)
- [Decision types](/Users/archerclawdington/veneer-os/web/src/lib/bots.ts)
- [Decision detail](/Users/archerclawdington/veneer-os/web/src/screens/Bots.tsx)
- [Image access presentation](/Users/archerclawdington/veneer-os/web/src/components/DecisionImages.tsx)
- [Mock browser check](/Users/archerclawdington/veneer-os/scripts/scoped-cs-return-browser-check.mjs)
- [Contract](/Users/archerclawdington/veneer-os/docs/reports/scoped-cs-return/contract.md)

Additional gallery/preview images and full/restricted guide captures in this report folder are synthetic fixture screenshots, not customer evidence.

## Deployment receipt

Implementation **f52eb47**, pushed to origin main. Root typecheck, full tests and production build passed before restart. The initial foreground restart was interrupted by its own runner restart; the same root `npm run restart` was then launched detached and completed normally. All four Node services and browser manager reported healthy; read-only HTTP checks returned 200 on 3100/3101/3102/3103/7300.

Post-deploy read-only checks using the built service and native DB:
- Nicholas user1: **12 raised hands, 12 answerable**.
- Ali user2: **12 raised hands, 12 answerable**; 11 cards limited to attached decision context.
- All five mixed-role source conversations still denied to Ali; her six explicit bot grants remain six.
- New immutable bridge schema exists; trust, mappings, claims and acknowledgments each contain **zero** live records.
- Unauthenticated dedicated verifier returns **401**.
- Built catalog includes both new capabilities in refreshed/resumed agent instructions. Full/restricted guide access and rendering passed isolated route/browser tests.

**Not configured:** `VP_RETURN_VERIFIER_CF_AUD` and `VP_RETURN_VERIFIER_CLIENT_ID` are both absent (presence-only check, no values disclosed). No trust is enrolled. Therefore the return producer is deployed but **not enabled for live use**. Required next owners/actions: Cloudflare/source service operator sets up the dedicated service path/identity; platform operator installs the two identifiers through protected runtime configuration; the authenticated native business owner enrolls verified account/principal/executor trust through the documented API; original OO owner completes its capture/transaction/dispatcher consumer and independent acceptance. The exact steps, HTTP bodies, and recovery semantics are in contract.md; this is not a request to reapprove the customer exception.

No live business acceptance or customer effect was performed. No whole-chat permission expansion, new user, live approval change, label purchase or refund occurred. Unrelated untracked workspace directories were preserved.
