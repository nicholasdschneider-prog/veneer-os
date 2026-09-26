# Training without software build slots

September 26, 2026 — source portion of build 374.

Authorized routine training text, procedural documentation, task records and isolated artifacts
no longer require a build slot. Shared software source, executable automation, dependencies,
schemas and deployment configuration still do. Mixed work queues only the software portion.
Bots coordinate overlapping file ownership, read fresh content, patch narrowly and read back.
This is guidance, not a filesystem lock or an automatic classifier of existing jobs.
Business approvals, connection permissions and existing queue entries are unchanged.

The common core (v15), tool description and employee catalog use the same boundary.
Fresh/new-turn instruction preparation delivers it to existing chats without changing their
fixed role snapshot. In-flight turns receive the guidance on their next turn.

## Verification

- Root typecheck passed.
- Full suite: 2,529 server tests passed, five skipped; 907 web, 40 browser-manager and 29 installer tests passed.
- Root production build passed (existing bundle-size warning).
- Isolated browser checks passed for full/restricted employees, desktop/mobile, training
  search and example copying, notices, navigation, permalinks, refresh, aging and error recovery.
- Resumed instruction regression confirms current guidance and preserved fixed snapshots.
- No external accounting actions were performed.

## Remaining Clara follow-through

The existing ERVP skill text and routine still need consolidation. This source release alone
does not complete that repair or certify live accounting. Continue using fresh current files,
one editor per overlapping file and native authorized routine management; preserve holds,
business authority, receipts and unknown effects. Do not replay invoices as validation.

## Changed source files

- [server/src/instructions/context.ts](/Users/archerclawdington/veneer-os/server/src/instructions/context.ts)
- [server/src/mcp/agentToolsServer.ts](/Users/archerclawdington/veneer-os/server/src/mcp/agentToolsServer.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/test/instructionContext.test.ts](/Users/archerclawdington/veneer-os/server/test/instructionContext.test.ts)
- [scripts/bot-guide-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/bot-guide-browser-check.mjs)
- [docs/bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [docs/reports/training-without-builds/report.md](/Users/archerclawdington/veneer-os/docs/reports/training-without-builds/report.md)

## Browser artifacts

- [desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/desktop.png)
- [employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/employee-mobile.png)
- [hands-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/hands-desktop.png)
- [hands-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/hands-employee-mobile.png)
- [retirement-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/retirement-desktop.png)
- [retirement-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/retirement-employee-mobile.png)
- [routine-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/routine-desktop.png)
- [routine-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/routine-employee-mobile.png)
- [routine-setup-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/routine-setup-desktop.png)
- [routine-setup-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/routine-setup-employee-mobile.png)
- [scope-review-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/scope-review-desktop.png)
- [scope-review-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/scope-review-employee-mobile.png)
- [teach-desktop.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/teach-desktop.png)
- [teach-employee-mobile.png](/Users/archerclawdington/veneer-os/out/clara-374/guide/teach-employee-mobile.png)
