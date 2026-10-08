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

Sage coordination thread `8b174872-0a5e-4660-92da-de04a8da9574` contains the actual new build chat ID, original evidence and request for current manual lane/portal clearance and exact deployment authority. The October 5 restart packet does not authorize a current restart. Current Sage source reports the unsubmitted cart and claim released, preserving the $27.93 quote and October 15 estimate for its separate cost-exception review. The build read the actual ERVP project standing deployment instruction saved for Nick (September 17) and verified the active owner plus current original task/team/project and native Platform Dev chat access. That saved instruction authorizes validated ERVP/OrderOps deployment; the native Veneer project has no saved deployment grant. Current exact native restart/successor clearance has not returned on the coordination thread. This build does not treat the old October 5 packet as current clearance or a bot report as new human authority. It retains deployment follow-through rather than restart over an unconfirmed current boundary.

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
