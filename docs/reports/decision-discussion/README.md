# Decision discussion and exact reply editing — BUILD282

Technical details, briefing, images, prior answers/results and case evidence now sit under **Details, evidence & history**, closed by default. Current recommendation, customer context, material limits, status and approval choices remain visible. Discussion follows the compact disclosure.

Authorized humans can **Edit customer reply → Save reply for review → Approve recommendation**. Structured message body is the actual edited field; account, recipient, subject, attachments and executor remain unchanged. Saving creates a new unapproved version and retains the old answer in immutable history. Legacy explicit draft text stays legacy and does not acquire structured send authority. Running/completed work cannot be edited.

Clean polling follows new bot proposal versions. Unsaved reply text remains in this browser tab across polling/navigation, with stale-version/handling conflicts shown explicitly. Discussion instructions tell bots to save a materially revised proposal with `update_decision`; ordinary discussion or saving text does not approve or send anything. Approval follows existing execution guards and is not a provider delivery receipt.

## Verification

Synthetic full-app browser checks passed at 320/375/414/768/1440 pixels in light/dark: default collapse, keyboard/tap reveal, exact-body save, disabled approval during edits, conflicting bot revision, preserved unsaved text, clean polling refresh, no overflow. Server fixtures cover exact payload preservation, immutable approval history, stale versions, request replay/conflicts, bot denial, shared reviewer/handling CAS, revoked/foreign access, restricted source context and no edit-triggered wake. Restricted employee route permits body-only editing, not raw proposal administration.

Full/restricted employee guide browser checks and current/resumed agent instruction coverage were checked. Root release checks and deployment receipt are recorded below after completion. No live customer, decision, call, refund or provider actions were used as tests.

## Release isolation

BUILD283 was stopped after cross-project queue overlap. Its five new source files, migration0119 and tracked handoff hunks were excluded from an isolated checkout based on ff20553. Canonical source was not reverted or cleaned. Its exact unfinished patch/files were additionally preserved in [BUILD283 archive](/Users/archerclawdington/veneer-build283-preserved/inventory.json). Only reviewed BUILD282 source and compiled artifacts are eligible for this release; neither BUILD283 nor the separately retained BUILD284 deferred-follow-up repair is claimed complete.

## Screenshots

Synthetic fixtures, scrolled to show the collapsed technical section and discussion:

![Mobile light](./375-light.png)
![Desktop dark](./1440-dark.png)

## Changed implementation

- [server/src/bots/employeeAccess.ts](/Users/archerclawdington/veneer-os/server/src/bots/employeeAccess.ts)
- [server/src/bots/routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [server/src/bots/service.ts](/Users/archerclawdington/veneer-os/server/src/bots/service.ts)
- [server/src/bots/replyEdit.ts](/Users/archerclawdington/veneer-os/server/src/bots/replyEdit.ts)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/test/botFeatureGuide.test.ts](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [server/test/bots.test.ts](/Users/archerclawdington/veneer-os/server/test/bots.test.ts)
- [web/src/components/BotProposalSummary.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotProposalSummary.tsx)
- [web/src/components/DecisionChoices.tsx](/Users/archerclawdington/veneer-os/web/src/components/DecisionChoices.tsx)
- [web/src/components/DecisionReplyEditor.tsx](/Users/archerclawdington/veneer-os/web/src/components/DecisionReplyEditor.tsx)
- [web/src/components/ui/textarea.tsx](/Users/archerclawdington/veneer-os/web/src/components/ui/textarea.tsx)
- [web/src/lib/bots.ts](/Users/archerclawdington/veneer-os/web/src/lib/bots.ts)
- [web/src/screens/Bots.tsx](/Users/archerclawdington/veneer-os/web/src/screens/Bots.tsx)
- [scripts/decision-discussion-browser-check.mjs](/Users/archerclawdington/veneer-os/scripts/decision-discussion-browser-check.mjs)

- [BotProposalSummary.test.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotProposalSummary.test.tsx)
