# Interrupted purchasing recovery — build 801

The exact interrupted purchasing task now has a staged, supported successor-recovery path. It restores the existing schedule only after the original custodian reviews fresh source and attempt evidence and shared portal ownership. The original UNKNOWN work is never resumed or rewritten.

Implementation passed final validation and is committed with this report. Production deployment and runtime recovery are pending; no business submission, runtime reset, restart, or purchasing retry occurred during this build.

## Original evidence and authority

[Read-only native evidence](./native-before.json) retains the current exact run, batch, worker start, pending-turn schema/status, schedule, pending successor, native archive hash, and prior startup exclusions. Nick's original repair direction is authenticated `bot_human_messages` source `0e03bf9a-a5ff-477c-9194-b50714dcecfb`, actor 1, in Sage `a6a9b2d4-384c-423a-a2fa-4f623aaeeb98`, at October 13, 2026, 19:08:47.720 UTC. Search corroborates original turn `93713f29-06ca-49b6-ad80-d2b7016a35f2`.

- Existing task: `9c72a42a-40df-4477-9ba6-07f74ac08bf3`, enabled, `*/15 7-21 * * *`, America/New_York.
- Original run: `7056b7cc-80d7-4504-b630-b11226b86eb3`, failed October 12, 13:15:43 UTC, “Purchase runner interrupted; no automatic retry.”
- Original batch: `551a9f86-fbde-412d-80e2-ae3230a61390`, blocked `UNKNOWN_RUNNER_RESTART`.
- Original worker: chat `79fd0a41-d395-4901-a9c8-24f0e1b446c7`, persisted turn `b5914b51-41ce-4406-bd31-a3300a33ac4b`. No pass acknowledgment.
- Pending successor: `338264c7-2083-4595-bf21-91ac2b4142f0`, original creation October 12, 16:13:16.529 UTC, no run.
- Stale next schedule: October 12, 13:30 UTC. The native transcript contains a Bash tool invocation; it is not a failure before model execution.
- Permanent prior exclusions remain `2080773d-b311-44a3-9b58-3e2eaa43664a` and `ae219af0-50ce-4ed8-95e7-f7e43fa3fbe3`.

Authenticated native runner `isLive` checks at October 13, 19:57:20 UTC returned false for both the original interrupted chat and Sage. These are runtime observations, not proof that no external effect occurred.

Sage and Boris received coordination updates identifying this build, the authentic source, the staged review contract, and the prohibition on duplicate repair or blind replay. The ERVP queue owner was notified before heavy validation; standard host locking and the single worker remained in use.

## Recovery contract

`recover_interrupted_purchase` calls `POST /api/scheduled-tasks/purchase-interrupted-recovery` with the exact `run_id` and `mode`.

1. **Inspect:** Owner, original source custodian, or connected Platform Dev reads the complete retained/current native Claude archive hash, exact run/start state, decision holds, and native human context. Context includes direct messages, result replies, decision discussion and human decision events, and shared voice directions. The actual original archive/current native file comparison matched, and context counts were 63 direct messages, 48 result replies, 56 discussion rows, 44 shared voice directions and 67 human decision events at the read-only verification. Archive mismatch, revoked access, live original runtime, missing worker start, pending native execution, or an existing pass blocks recovery.
2. **Review:** Only the original registered source custodian (or the human owner directly) may record an immutable review. It pins the unchanged inspection hash, exact authentic post-interruption owner message and text, complete context assessment, fresh original source evidence and complete attempt census, every potentially attempted canonical order ID and number, no unscoped UNKNOWN, preserved source purchase fences, and the coordinated original portal release. An idle flag alone is insufficient.
3. **Resume:** Owner/Platform Dev submits the exact saved `review_id` and unchanged `expected_hash`. Evidence must still match, source/portal observations must be at most 15 minutes old, native decision scope must be mapped, and no other unresolved run fence may exist. An append-only disposition removes only this run's task-wide successor block. The existing schedule advances to the next occurrence of its unchanged cron specification; no parallel task or replacement batch is created by recovery.
4. **Verify:** Read the future `next_run_at`, then a distinct successor run and its persisted actual worker turn. A disposition, queued/running label, receipt acceptance, or idle runtime is not purchasing proof. The original executor retains fresh source eligibility, duplicate, submission, date, cost, and ownership gates, including #100122597.

Original run, blocked batch, start, pending/queued messages, audit, and pass history stay untouched. Immutable disposition exclusions do not depend on mutable batch labels. Original hints and the fresh census's attempted/UNKNOWN IDs and numbers are excluded from candidate selection and full source scans/daily backup. New event IDs cannot bypass the canonical order exclusion. Prior startup exclusions and native decision holds are retained. A backlog containing only excluded/held hints cannot hot-loop. Readback retains the interrupted disposition separately from the immutable startup disposition and worker start.

An identical resume request is idempotent. After an uncertain resume response, inspect the original disposition and reuse the original saved run/review/hash tuple if necessary; never manufacture a new key or retry a purchase. A changed tuple conflicts. No review or disposition supplies business permission or establishes any original source outcome.

Run-now now distinguishes active execution, invalid binding, unresolved purchase fence, unmapped decision scope, no eligible pending candidates, and schedule collision. A purchase fence response includes the exact blocked run and reason.

## Validation

- Node 24.21.0 was selected explicitly because the shell's default Node 22 cannot load its missing simdjson library. No global runtime or dependency change was made.
- Focused recovery, employee guide, and MCP tests: **112 passed**.
- Root `npm run typecheck`: **passed**.
- Full `npm test`: **passed** across installer, server, web and browser manager. After the permanent-exclusion guard was tightened, the complete set was repeated on the final source; no validation overlapped.
- Root `npm run build`: **passed** (server and web).
- `git diff --check`: **passed**.

Tests cover preserved original records, actual successor turn association, attempt-only backlog, prior startup exclusions, immutable ledgers, authentic original custodian/message binding, changed native/human/task/decision/voice evidence, stale census, unscoped UNKNOWN, unreleased portal, another unresolved run, and native runtime unavailability. Native source readbacks are not fabricated by synthetic tests. Full/restricted employees can discover the staged guide; next-turn MCP discovery and dispatch expose the tool to fresh/resumed agents after installation. As a staged single-custodian capability, it has no global injected prompt.

## Deployment and activation

Deployment requires an explicit human-approved maintenance window and drained active turns. [AGENTS.md](/Users/archerclawdington/veneer-os/AGENTS.md) says: “Do not restart production as the automatic last step of a build.” No previous ERVP deployment grant has been treated as permission to interrupt services.

Only web and runner are affected. Inside the approved window, use `npm run restart -- --maintenance-approved veneer-pro veneer-pro-runner`. Both service names were checked against `scripts/restart.mjs`; its active-turn drain refusal remains mandatory. No app-runner, terminal, browser manager, direct signal, launchctl, detached watcher, or active-turn override is needed. Web startup applies migration 0178 before the new runner/schema-dependent scheduler begins; startup health must be verified. Native restart clearance is separate from the original purchasing authority.

Sage’s October 13, 19:59 UTC own-source readback still found #100122597 blocked by both UNKNOWN guards, with no recorded attempts or confirmation. Sage could not yet certify no unscoped UNKNOWN or shared portal release. Those gates remain unsatisfied; the readiness/queue GET in the transcript alone cannot settle source outcomes.

After installation, Sage must freshly inspect and record the original-source review, then Platform Dev may record the exact successor disposition. Report live recovery only after the distinct run/worker-start and future-schedule readbacks. This report does not claim installation, restored cadence, a new production run, or purchase success.

## Files

- [Interrupted recovery implementation](/Users/archerclawdington/veneer-os/server/src/botWorkflows/purchaseInterrupted.ts)
- [Append-only migration](/Users/archerclawdington/veneer-os/server/src/db/migrations/0178_purchase_interrupted_recovery.sql)
- [Candidate fences and readback](/Users/archerclawdington/veneer-os/server/src/botWorkflows/purchaseEvents.ts)
- [Scheduler outcomes and full-scan exclusions](/Users/archerclawdington/veneer-os/server/src/scheduled/scheduler.ts)
- [Authenticated API and runtime guard](/Users/archerclawdington/veneer-os/server/src/routes/scheduledTasks.ts)
- [Runner result type](/Users/archerclawdington/veneer-os/server/src/runner/client.ts)
- [Native MCP tool](/Users/archerclawdington/veneer-os/server/src/mcp/agentToolsServer.ts)
- [Feature-guide release note](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [Employee/agent feature guide](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [Recovery tests](/Users/archerclawdington/veneer-os/server/test/purchaseEvents.test.ts)
- [MCP discovery/dispatch tests](/Users/archerclawdington/veneer-os/server/test/agentScheduledTaskTools.test.ts)
- [Native evidence](/Users/archerclawdington/veneer-os/docs/reports/purchase-interrupted/build801/native-before.json)
- [This report](/Users/archerclawdington/veneer-os/docs/reports/purchase-interrupted/build801/report.md)
