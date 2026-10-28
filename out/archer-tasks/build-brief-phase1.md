# Build brief: Shared Tasks capability for all VeneerBots (phase 1)

Status 2026-10-28: Nick approved "go ahead with build" in Archer's chat f4131f81 (result thread
1ed75c0b, human source 557befc2). The queue tool refused the enqueue from the coordination turn
(f44dc39e) because only a turn Nick or James starts can queue a build. Queue is empty; no duplicate.
Deployment, restart and live task migration are NOT approved.

Authoritative scope: scope-2026-10-28.md (Addendum 2 + authority note + Nick's answers block).

## Phase 1 (one slot)
1. Migration: bot_tasks (owner, title, status up_next|working|needs_input|ready_for_review|done,
   source, task_conversation_id, status_line, case_key unique per owner, resources_json, closed_by
   human|auto) + bot_task_events; nullable task_id on bot_decisions. New numbered migration only.
2. GET /api/conversations/:id/tasks for any bot chat: unions bot_tasks, own needs_input decisions,
   coordination threads, handed-off chats (origin_conversation_id), and openQuestions() only behind
   the existing chiefOfStaffActive check. Status from source state only; per-group counts.
   POST mark (human: done|reviewed). Bot tools: set_task_status, create_task, match_task.
3. Auto-close only when bot reports completion AND readback verifies AND no bound card open AND no
   UNKNOWN effect; else stays waiting with truthful status line.
4. Intake: split a multi-ask message into tasks, match by case_key then title to open tasks of the
   same owner, create only unmatched; matched direction goes into the existing task lane. Intake is
   never approval; money/sends/submissions use raise_decision per task bound by task_id.
5. Task chats: one coordination lane per task (cs_tickets.createLane mechanism), reused on match.
6. Web: CHAT | TASKS toggle on every bot chat (?view=tasks + localStorage), counts on toggle,
   groups Ready for review / Needs input / Doing work / Up next, Completed filter; rows open the
   existing side panel (decision card by id, coordination panel, handed-off chat); Discuss
   pre-mentions the task. No duplicate cards; existing pill/strip/Bots section/Tickets tab untouched.
7. Scheduler: cap 2 working per owner within host limits; resources (browser:<profile>,
   case_lease:orderops:<identity>, account:<name>), one holder each, others shown "Queued: waiting
   for <resource> (held by task X)"; unshared preparation keeps running.
8. Restart/import safety: reconcile working tasks against source systems (UNKNOWN rules) before any
   rescheduling; idle lane never proves no effect; import of existing cases is visibility only, no
   replay.
9. Catalog entry tasks-board (docs/bot-feature-guide.md), shared bot skill text for intake/status.
10. typecheck, scoped vitest, full npm test once, npm run build, commit, push; NO restart; report
    release readiness to thread f44dc39e for Nick via Archer.

## Phase 2 (separate slot after phase 1 validation)
Full resource-queue persistence, OrderOps lease serialization detail, Miles Tickets tab as board
view, cap tuning on host measurements only, redundant UI consolidation after Nick's feedback.

## Acceptance
Return after hours, see counts, open/answer/discuss one task, return with the rest intact. Clara
five chargebacks → five tasks/lanes/cards, one answer affects one case. Finn five returns → five
tasks reaching ready_for_review independently, OrderOps steps serialized and shown queued. No card
twice; answers record on the original decision id with original approver and executor.

## Delivered — build #908 (2026-10-28)
All ten numbered items shipped in one slot:
1. Migration 0188: bot_tasks, bot_task_events (immutable), bot_task_marks, nullable bot_decisions.task_id.
2. GET /api/conversations/:id/tasks (tasks, own open questions, chief-of-staff questions behind the existing check, coordination threads, handed-off chats, mirrored tickets; status from source state; per-group counts); POST …/tasks/mark; POST …/tasks/:taskId/discuss; GET …/tasks/:taskId. Bot tools create_task, intake_tasks, set_task_status (server/src/tasks/*, server/src/mcp/botTools.ts).
3. Auto-close only with completion.verified_by_readback, no open card bound to the task, unknown_effects false; otherwise the task stays ready_for_review / needs_input with the reason in the status line.
4. Intake: items matched by case_key then equivalent title against the owner's open tasks; matched items add direction (and wake the task chat); the rest are created; summary "N tasks: X new, Y matched; S started, Q queued". Decisions raised from a task chat bind to the task and park it in Needs input; answers wake the task chat (wakeTarget).
5. Task chats: insertOwnerLane (shared with ticket chats), task record injected each turn, task-specific lane rules.
6. Web: ChatTasksToggle in every chat header with the needs-you count; ?view=tasks renders TasksBoard (Ready for review / Needs input / Doing work / Up next, Completed filter; rows open the existing card, coordination panel, handed-off chat or task chat; task rows expand to record, history, discussion box and Mark it done). Existing pill/strip/Bots section/Tickets tab untouched.
7. Scheduler: cap 2 working per owner; shared resources (browser:, case_lease:, account:, other:) one holder each with "Queued: waiting for <resource> (held by task X)"; runs on create/intake/status change and every 30 s in the bot background loop; task lanes of one bot run concurrently up to the cap in conversationManager (human chat first).
8. Restart: reconcileAfterRestart wakes each working task once per boot with the UNKNOWN-rules prompt before anything is rescheduled; import is visibility only (no replay); existing cs_tickets appear on the board without migration.
9. Catalog entry tasks-board (with prompt) + docs/bot-feature-guide.md section.
10. Validation: root typecheck, full npm test (server 282 files, web 147, browser-manager, installer; one timing-flaky purchaseEvents test passed on rerun and alone), npm run build. Not restarted.
Deployment: web + runner (tools, routes, runtime concurrency, migration 0188) in a Nick-approved window. Phase 2 unchanged.
