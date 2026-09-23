# CS draft follow-through

BUILD275, September 23, 2026. Deployed in `cb7fbff`, followed by the separate history change `c1ae1be`; both pushed to origin/main. Root restart completed successfully. Read-only health checks returned HTTP 200 for web, runner, app-runner, terminal and browser-manager at 22:43:16 UTC. No live customer, refund, draft, decision, access, enrollment, lease or provider mutation was performed.

The opted-in ERVP CS lane now shows central human questions separately from technical authority/source blockers, queued work, uncertain effects, receipts and retirement. The ordinary per-draft Send action is unavailable in that lane at both UI and API; outside it the prior human-send workflow remains. Existing original structured approval obligations are visible separately, never attached to a differing draft. William’s differing ordinary draft remains unbound; his original approved message and completed refund remain intact.

The routine contract now checks native decision coverage directly and requires a dedicated authenticated one-time service dispatch association. A bot claim is only a reservation (`execute:false`). Replay and reconciliation never grant send permission. Legacy unscoped native decisions conservatively block the whole business, including unrelated unresolved records; no silent scope guessing occurs.

Read the [executable contract and remaining dependencies](./contract.md). BUILD276 retains source ownership. Dedicated routine adapter/config/enrollment and independent business acceptance remain incomplete. BUILD250 still lacks trusted case-mapping transport; legacy unstructured approvals remain non-importable. This release does not claim customer delivery.

Validation: root typecheck, full tests (2,381 server passed / 5 skipped; 877 web; 40 browser-manager; 21 installer), and production build passed. Focused tests cover lane isolation, human-send rejection, ordinary workflow preservation, authority classification, native hold arrival between reservation and dispatch, authenticated one-time dispatch/replay and immutable audit. Synthetic browser checks covered 320/375/414/768/1440 in light/dark, keyboard central links, no CS Send CTA, ordinary Send retained, and no horizontal overflow. Full/restricted guide and resumed-instruction tests passed.

![Mobile draft states](./375-light.png)
![Desktop draft states](./1440-dark.png)

## Changed files

- [docs/reports/cs-draft-follow-through/1440-dark.png](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/1440-dark.png)
- [docs/reports/cs-draft-follow-through/1440-light.png](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/1440-light.png)
- [docs/reports/cs-draft-follow-through/375-dark.png](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/375-dark.png)
- [docs/reports/cs-draft-follow-through/375-light.png](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/375-light.png)
- [docs/reports/cs-draft-follow-through/README.md](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/README.md)
- [docs/reports/cs-draft-follow-through/contract.md](/Users/archerclawdington/veneer-os/docs/reports/cs-draft-follow-through/contract.md)
- [scripts/cs-drafts-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/cs-drafts-browser-check.mjs)
- [scripts/fixtures/cs-drafts.tsx](/Users/archerclawdington/veneer-os/scripts/fixtures/cs-drafts.tsx)
- [server/src/bots/communication.ts](/Users/archerclawdington/veneer-os/server/src/bots/communication.ts)
- [server/src/bots/csDraftState.ts](/Users/archerclawdington/veneer-os/server/src/bots/csDraftState.ts)
- [server/src/bots/routineExecution.ts](/Users/archerclawdington/veneer-os/server/src/bots/routineExecution.ts)
- [server/src/bots/routineVerifierRoutes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routineVerifierRoutes.ts)
- [server/src/db/migrations/0117_routine_dispatch_claims.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0117_routine_dispatch_claims.sql)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/test/botCommunication.test.ts](/Users/archerclawdington/veneer-os/server/test/botCommunication.test.ts)
- [server/test/csDraftState.test.ts](/Users/archerclawdington/veneer-os/server/test/csDraftState.test.ts)
- [server/test/routineExecution.test.ts](/Users/archerclawdington/veneer-os/server/test/routineExecution.test.ts)
- [web/src/components/BotCommunication.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotCommunication.tsx)
