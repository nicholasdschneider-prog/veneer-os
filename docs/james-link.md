# James link

Built 2026-10-12 (build #719) at Nick's request through James: James, who works for Nick and runs his own Grok Bot,
and Veneer talk directly, with no Nick relay. Source: `server/src/jamesLink/`, migration `0167_james_link.sql`.

## Thread registry

Every chat is a thread (`james_threads`, thread_id = conversation id) with `started_by` (james, nick or bot),
`followed` (James follows it), `status` (open, waiting_on_james, waiting_on_veneer, done, archived), a turn counter
and `last_activity`. Every message in either direction gets the next turn in `james_thread_messages`. Existing chats
were backfilled once from the search index: an opening "From James" or "James for Nick" means James started it; any
early mention of James means he follows it. A Veneer reply whose last paragraphs ask a question sets
waiting_on_james.

## Push to James

The web service POSTs JSON to Doppler `JAMES_WEBHOOK_URL` (main/prd) with `Authorization: Bearer <JAMES_WEBHOOK_KEY>`,
`X-Veneer-Signature: sha256=<HMAC of the body with the same key>` and `Idempotency-Key: veneer-james-push-<id>`.
Reasons: a Veneer reply in a thread James started or follows; a question unanswered for 15 minutes; 2 quiet hours
between 7 AM and 9 PM ET, 12 otherwise (threads active in the last week, once per quiet period); the daily 8:30 AM ET
heartbeat (`type: veneer.heartbeat`). Reasons batch to at most one push per thread per 15 minutes.
Two failed POSTs send the same alert by email from the owner's Gmail connector to nicks@mail.grokbot.com, or
nick@elkhartrvparts.com if that send fails. A webhook failing for 2 hours emails Nick once. Log: `james_pushes`.

## James API

`https://nicksworld.dev/api/james`, with `Authorization: Bearer <VENEER_JAMES_API_KEY>` (Doppler main/prd; only its hash
is compared in memory). Cloudflare Access app "Veneer James Link API" (a65a10fa-2539-4d63-a192-347d6090670e) bypasses
the owner login for this path only.

| call | effect |
|---|---|
| `GET /threads?started_by=james&waiting_on=james\|veneer&status=a,b&james=1&q=&limit=&offset=` | list (archived excluded unless asked; `waiting_on_james=1` still works) |
| `GET /threads/:id` | thread plus its last 20 messages |
| `GET /threads/:id/messages?limit=1-100&before=<ISO>` | older pages; follow `next_before` until it is null |
| `POST /threads/:id/reply {expected_turn, text}` | posts into the chat; 409 `stale_turn` with `current_turn` if behind |
| `POST /threads/:id/close` / `archive` / `reopen` `{expected_turn?}` | status change; archive waits while a reply is being written |
| `POST /threads/:id/follow {follow}` | follow or unfollow |
| `POST /test-push {thread_id, simulate_webhook_failure?}` | immediate test push |
| `GET /docs` | machine-readable description of every endpoint (`server/src/jamesLink/docs.ts`) |
| `GET /projects` | Workspace projects with default agent, open thread count and last activity |
| `POST /threads {project_id?, title, text}` | new chat under James's name (project default agent, site model defaults); text is turn 1; James follows it; 201 |
| `GET /bots` | active registered bots with their standing chat as a thread |
| `POST /bots/{bot}/message {text, expected_turn?}` | message a bot by name or chat id in its standing chat |

Since build #722 every POST accepts an `Idempotency-Key` header (`james_idempotency`, kept 30 days). A replay with the
same key and body returns the stored response with `Idempotent-Replay: true` and posts nothing; the same key with a
different body is 409 `idempotency_conflict`; 5xx responses are not stored.

James writing in a bot's standing chat does not make him follow it. The turn that starts with his marked message is
recorded in `james_threads.james_answer_turn_id`, and only that turn's reply is pushed (`answers_james: true`).

Messages carry `turn`, `role`, `direction`, `via`, `at`, `text` (up to 20,000 characters) and `source`. Stamped `ledger` rows (since go-live) have a turn and role james, human, bot or veneer. Older messages come from the search index as `history`, with no turn and role user or assistant, only from before the first stamped row.

James's replies reach the chat as `[James link · thread <id> · turn <n>]` followed by his text. Done threads archive
themselves after 7 quiet days. Nothing is deleted.

Email backup: a reply from nicks@mail.grokbot.com or nick@elkhartrvparts.com, with a `[VENEER` subject, whose first
unquoted line starts with `CLOSE` or `ARCHIVE` (uppercase) acts on the thread id in that line or in the subject. The
inbox is polled every 2 minutes and every command is recorded in `james_email_commands`.
