# close_chat — one chat per issue

Approved by Nick on 2026-10-14 (Platform Dev chat e2ac6495) as part of the chat-hygiene
program: one chat per issue, worked to completion, reported, then archived. Build #832.

## What it does

`close_chat` is a built-in agent tool (`server/src/mcp/closeChatTool.ts`) that calls
`POST /api/conversations/:id/close` (`server/src/routes/api.ts`, logic in
`server/src/conversations/closeChat.ts`). It:

1. Checks the calling chat can be closed, then checks the blockers below.
2. Sends the final report through the normal coordination path to `report_to`
   (default: the chat's `origin_conversation_id`, the chat that handed it off), with a
   stable request key so a retry never sends twice. `report_to: null` only records it.
3. Archives the chat the same way manual archive does (`archived = 1`, unpinned, linked
   active todos marked done) and records a row in `chat_closures` (migration 0183).

A repeat call on a closed chat returns the stored closure. A message that later reaches
the chat reopens it as usual, and a later close records a new report.

## Never closed

- Another chat: only the agent-token chat itself, and not from a coordination lane.
- A registered bot's standing chat (active `bot_registrations` row), a pinned chat, an
  automation chat, or a side chat.

Closing never deletes. Archived chats keep their history, audit rows and
`search_workspace` documents (the search query has no archived filter; pinned by
`server/test/closeChat.test.ts`).

## Blockers

The refusal names each blocker and its ids:

| kind | source |
|---|---|
| `pending_wakeup` | `conversation_wakeups.status = 'pending'` |
| `active_build` | `build_queue` rows in queued, running, failed or stopped. A build chat closes in a later turn, after its slot is released. |
| `open_decision` | `bot_decisions` in needs_input, action_pending, running, blocked, or decided with an answer other than reject/defer/withdraw |
| `pending_question` | `questions.status = 'pending'` |
| `undelivered_message` | `bot_message_drafts` queued/sending/uncertain/failed or authorized drafts; `bot_message_delegations` (owner or executor) with no `sent` or `revoked` event |
| `queued_message` | `queued_messages` waiting for the chat |
| `deployment_status_required` | the chat has `done` builds and passed no `deployment` |
| `deployment_not_reported` | `deployment.status = 'pending'` and a waiting chat has no message from this chat since the latest build finished |

### Deployment check

Build rows record that code was finished, not that it went live, and this install has no
per-build deployment record. So a chat with finished builds must state `live` (verified
running), `none` (nothing to deploy), or `pending`. For `pending`, the waiting chats are the
listed `notified_conversation_ids` plus the requester (origin chat). Each one needs an
`agent_message_receipts` row from this chat with `created_at` at or after the latest build's
`finished_at`, unless it is `report_to`, because the report itself tells it. `live` and `none` are
the bot's own statements; they are stored in `chat_closures.deployment_json` for audit.

## Auto-archive guard

The same build makes the inactivity sweep (`server/src/routes/chatAutoArchive.ts`) skip any
chat that still has a pending wake-up, queued message, pending turn, pending question card,
queued/running/failed/stopped build, or open decision. Archiving cancels a chat's pending
wake-ups at delivery time and drops its queued work, so without this a quiet chat (including a
coordination lane) could lose a scheduled follow-up when the inactivity window is shortened.
