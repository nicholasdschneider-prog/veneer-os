# Build 653 — bounded Lippert startup reconciliation

The repair separates a proven provider failure before model execution from an uncertain business outcome. An append-only disposition can remove only that failed run’s task-wide successor fence. The original failed run, blocked batch, worker-start record, receipts, event identities, hinted orders and unconsumed continuation remain retained and blocked. No worker-pass acknowledgment is fabricated. No event is rePOSTed, rekeyed or replayed.

## Original source and current disposition

The commissioned build owns chat `7cdf1e39-7eeb-4d87-b5d2-3382384f0a57`, queue #653. Original Sage chat `a6a9b2d4-384c-423a-a2fa-4f623aaeeb98` contains Nick’s authenticated result reply `37c3a321-b2ac-40a3-b0b5-f64345393a49` on thread `0e9d073c-c8b9-4b3d-a263-844cdf6624c4`, directing bug repair and the dropship. Purchasing remains with Sage and its existing source rules. This build does not purchase.

Original task `9c72a42a-40df-4477-9ba6-07f74ac08bf3`, source `90ef6920-4bbd-4bb9-852d-02868dd8b05b`:

- Latest original run `ed3dac84-83b9-4e0d-a3e4-2f50ba103932` / conversation `332c1946-f69b-420a-9d4d-b6764f1828ad` remains failed, October 7 17:43:49 UTC.
- Its original batch `6eba4560-30fd-4512-bde0-f3e01cd734d2` remains blocked with `WORKER_OUTCOME_UNRESOLVED`. Its hint was event `4910d152-79d3-474d-9770-15512e8a47e5`, order #100122451; it was not a #466 run.
- The manager did persist start `a466b32e-850b-4286-a8a7-e0e13be000d3`. Manager start is distinct from model execution. No pass acknowledgment exists.
- Full retained native session `b9b651c5-4307-4aab-a279-38ea839dd805` exactly matches the current native file. It has one initial user prompt and one provider-marked synthetic assistant HTTP 429 / rate_limit response. There is no model or tool output, tool result or sidechain. The native error matches the failed run’s error.
- One unconsumed queued continuation remains. The existing manager’s blocked-purchase-chat gate prevents it from running; this repair neither cancels nor consumes it.
- Read-only inspection under this actual Platform Dev chat and active owner/task/team/project permissions returns `failed_before_model_execution`, `schema_ready:false`, `reconciled:false`, `execute:false`, `purchase_authority:false`. Review hash: `a571b35cbf4cc689d667c3f3ead45613bcb6b9151fdd92f33a521ee74ba99072`. Reinspect before any later reconciliation; this historical hash is not a freshness extension.
- #466 intake `f050bc3a-214c-44ff-af7f-40f0b31d721c` remains in pending batch `a97e8438-8b36-473a-9dfa-882d339b4745`, with no run association or worker start. Its displayed block derives from the earlier failed run’s task-wide fence. Older successful runs cannot clear the later failure.

Production evidence was read-only. No migration, disposition, launch, purchase or pass acknowledgment was written by inspection.

### October 8 manual-lane acceptance correction

Sage reported in coordination thread `8b174872-0a5e-4660-92da-de04a8da9574` that the existing source manual plain-lane claim for #100122466 succeeded at 13:56:31 UTC under its own executor `a6a9b2d4-384c-423a-a2fa-4f623aaeeb98`, with no attempts. This is source-owner acceptance evidence, not an independent Platform Dev portal verification. The native `WORKER_OUTCOME_UNRESOLVED` fence blocks automatic successors; it does not prevent that existing manual source claim. Sage explicitly corrected its earlier report that treated the successor fence as preventing all manual purchasing. This repair adds no manual integration gate and does not change the source manual lane or its business guards.

Sage's current prepared checkout is item 2022068082 ×1, $27.93, estimated October 15, PO100122466 committed, against source baseline $16.61 and ground $0. Its separate cost-exception decision `a2bdd5ea-1af7-4138-a305-23463cc3212a`, version 1, was reported `needs_input` at 14:05:11 UTC. No before-submit or Place action occurred and no supplier effect was reported. The active unsubmitted cart/manual claim supersedes earlier released-cart coordination for deployment safety. Sage will clear/release before providing exact deployment/runtime clearance; claim expiry alone is not clearance. Historical UNKNOWN fences remain intact.

## Supported reconciliation

`POST /api/scheduled-tasks/purchase-startup-reconciliation` uses the existing authenticated identity boundary. An active installation owner or that owner’s authenticated Platform Dev chat must have access to the original run, current original task binding, owner/team/project and its own chat. An ordinary purchasing worker cannot use the repair as Platform Dev.

Inspect input: `{run_id, mode:"inspect"}`. The server reads complete bounded files from its own archive and native Claude session paths. No caller transcript bytes, proof booleans, foreign identity or replacement key are accepted. It requires a failed, blocked original run with one initial user prompt, one matching provider-marked synthetic 429 response, the persisted original manager start and hinted event/task linkage. Unknown record types, sidechains, tool/model output, malformed/incomplete/mismatched files, active pending turns, UNKNOWN launch/restart/source outcomes, existing worker passes and revoked access fail closed.

After current original Sage manual-lane/shared-portal coordination and authorized installation, reconcile input is `{run_id, mode:"reconcile", expected_hash, coordination_reference}`. The fresh hash pins full native bytes, run/batch, binding, worker start, hint IDs and retained queue. Repeated identical reconciliation does not create another disposition. Changed material requires a new inspection; existing immutable evidence is never replaced.

The scheduler considers a reconciled startup batch’s global fence separately from its permanently blocked original hint fence. Later unrelated hints can use the existing bounded worker. Failed original orders are excluded from both hinted work and full source queue/daily backup prompts. New event IDs for those orders are refused; exact original receipt replay remains read-only/idempotent. Already queued duplicate hints display blocked and are excluded. A backlog containing only excluded hints does not hot-loop. The eight-order bound counts only unrelated eligible hints. Source purchase/claim/portal/UNKNOWN and per-order business guards remain unchanged.

This is a scheduling reconciliation, not proof of provider order absence for unrelated work, a purchase approval or a bypass of source execution mediation. Fresh supplier duplicate checks remain with the real executor.

## Validation and deployment

Root `npm run typecheck`, the full root `npm test` (installer, server, web and browser-manager), and `npm run build` all passed using Node 24. Browser-manager: 51 passing; web: 1,013 passing; installer: 30 passing. The final focused purchase/guide run passed 73 tests, including API actor restrictions, immutable dispositions, file/hash drift, original/queued duplicate exclusions, no hot-loop, retained continuation and all permanent UNKNOWN/global fences. Existing instruction-context tests also passed. `git diff --check` passed.

Implementation is built and staged, not installed or reconciled in production. No restart occurred; production disposition schema remains absent and the original failed run and successor fence remain unchanged.

The guide entry `/#/bot-guide?feature=lippert-purchase-events` documents the supported endpoint, owner access, exact evidence, portal coordination and staged status. Contract tests verify full/restricted employee access and fresh/resumed agent delivery.

Sage coordination thread `8b174872-0a5e-4660-92da-de04a8da9574` contains the actual new build chat ID, original evidence and request for current manual lane/portal clearance and exact deployment authority. The October 5 restart packet does not authorize a current restart. An earlier Sage report said the unsubmitted cart and claim were released; the October 8 acceptance correction above supersedes that operational status with an active unsubmitted cart/manual claim. The build read the actual ERVP project standing deployment instruction saved for Nick (September 17) and verified the active owner plus current original task/team/project and native Platform Dev chat access. That saved instruction authorizes validated ERVP/OrderOps deployment; the native Veneer project has no saved deployment grant. Current exact native restart/successor clearance has not returned on the coordination thread. This build does not treat the old October 5 packet as current clearance or a bot report as new human authority. It retains deployment follow-through rather than restart over an unconfirmed current boundary.

## Build 654 — fresh deployment checkpoint, October 8

Queue #654 became active in this original chat. This continuation changed documentation only. The source remains `b812934`; the prior manual-lane correction is `5ed94aa`. The existing successful #653 checks are historical validation, not newly run #654 checks.

Sage’s authenticated coordination message 33 (turn `85fca8d5-756f-40b6-b070-ad49c4372363`, October 8 14:18:02 UTC) supersedes the active-cart status above: the sole unsubmitted #466 item was removed, the authenticated portal reported an empty cart, and the original claim release returned HTTP 200 / `released:true`, `execute:false`, `attemptHistoryPreserved:true`. Sage reported no before-submit, Place, acceptance, writeback or active purchase. This clears Sage’s current manual work only; it does not clear historical UNKNOWN or grant human restart authority.

Fresh readback confirms native cost decision `a2bdd5ea-1af7-4138-a305-23463cc3212a` remains version 1, `needs_input`, parked in the original Sage chat, order #100122466. Its version, ownership and cost guards were untouched.

Two precise boundaries prevent this deployment/reconciliation continuation:

1. **Native restart authority remains unverified.** The actual saved ERVP project instruction grants completed validated ERVP/OrderOps push/deploy; native Veneer project instructions remain empty. Bounded original/source and workspace review returned no current human grant for installing this native artifact and restarting Veneer. Search coverage is not proof that no grant exists. Sage’s operational clearance is not substituted for human authority, and the historical October 5 packet is not reused. The conditional #654 request expressly requires verification before restarting.
2. **Reconciliation would make the pending #466 batch dispatchable.** Current batch `a97e8438-8b36-473a-9dfa-882d339b4745` remains pending/run null and contains #466 event `f050bc3a-214c-44ff-af7f-40f0b31d721c` / original canonical order `087620d4-c538-4c02-8285-6004cd710766`, alongside other retained hints. In `b812934`, the scheduler dispatches pending batches after the reviewed original startup disposition removes the global fence. Its exclusion predicate covers the reconciled original failed hints (the #451 startup run), not #466’s separate cost question. Source cost checks can prevent purchasing, but do not establish that #466 will not be included in an automatic native worker launch. The current no-automatic-#466-launch instruction therefore prevents writing the disposition as-is. No event is moved, retired, rekeyed or replayed to work around this boundary.

Using this chat’s existing authenticated tool identity directly at its approved loopback API, POST `/api/scheduled-tasks/purchase-startup-reconciliation` with exact original run and `mode:"inspect"` returned HTTP **404**. No reconcile request was made. Read-only SQLite confirms the disposition schema is absent, original run `ed3dac84-83b9-4e0d-a3e4-2f50ba103932` remains failed, original batch `6eba4560-30fd-4512-bde0-f3e01cd734d2` remains blocked / `WORKER_OUTCOME_UNRESOLVED`, and its one unconsumed continuation remains retained.

No source software edits, fresh deployment tests/build, restart, production migration/disposition, worker launch, event replay, pass acknowledgment or purchase occurred in #654. Validation/restart remain conditional on verified authority; disposition additionally requires a supported way to honor the current #466 launch boundary. These are native deployment/scheduling boundaries, not a new gate on Sage’s working independent manual source claim. The exact findings were returned to Sage on the same coordination thread. No duplicate human approval or new build commission was created.

## Changed files

- [Startup reconciliation](/Users/archerclawdington/veneer-os/server/src/botWorkflows/purchaseStartup.ts)
- [Immutable disposition migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0162_purchase_startup_dispositions.sql)
- [Candidate receiver/readback](/Users/archerclawdington/veneer-os/server/src/botWorkflows/purchaseEvents.ts)
- [Scheduler](/Users/archerclawdington/veneer-os/server/src/scheduled/scheduler.ts)
- [Authenticated route](/Users/archerclawdington/veneer-os/server/src/routes/scheduledTasks.ts)
- [Employee and resumed-agent catalog](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Regression tests](/Users/archerclawdington/veneer-os/server/test/purchaseEvents.test.ts)
- [Guide delivery tests](/Users/archerclawdington/veneer-os/server/test/botFeatureGuide.test.ts)
- [Living guide documentation](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/lippert-startup/build653/report.md)
