/** Served at GET /api/james/docs: every endpoint, for James and his Grok Bot. */
export const JAMES_API_DOCS = {
  name: 'Veneer James API',
  version: 2,
  base_url: 'https://nicksworld.dev/api/james',
  auth: 'Authorization: Bearer <key>. The key is the Doppler secret VENEER_JAMES_API_KEY (project main, config prd). 30 failed attempts in a minute get 429.',
  idempotency: 'Send an Idempotency-Key header (8-200 printable characters) on any POST. A retry with the same key and body returns the stored response with the header Idempotent-Replay: true and posts nothing. The same key with a different body is 409 idempotency_conflict; a key still running is 409 idempotency_in_progress. Keys are kept 30 days. Server errors are not stored, so retrying them runs again.',
  turns: 'Every thread (a Veneer chat; thread_id is the chat id) has a turn counter stamped on every message in both directions. Replies name the turn they answer (expected_turn); a reply behind the current turn is 409 stale_turn with current_turn.',
  endpoints: [
    { method: 'GET', path: '/docs', description: 'This description.' },
    { method: 'GET', path: '/projects', description: 'Workspace projects: project_id, name, slug, default_agent, open_threads, last_activity.' },
    { method: 'GET', path: '/threads', query: 'started_by=james|nick|bot, waiting_on=james|veneer (waiting_on_james=1 also works), status=open,waiting_on_james,waiting_on_veneer,done,archived (comma list; archived excluded by default), james=1 (started or followed by James), followed=0|1, q=<title text or id prefix>, limit<=500, offset', description: 'List threads, newest activity first. Returns total and threads[] {thread_id, title, started_by, followed, status, turn, last_activity, url}.' },
    { method: 'POST', path: '/threads', body: '{project_id?, title, text}', description: 'Start a new thread in a project (default agent). James\'s text is turn 1; James follows the thread for pushes. 201 with thread_id, turn, url.' },
    { method: 'GET', path: '/threads/{id}', description: 'One thread (full id or unique 8+ character prefix) and its last 20 messages, oldest first. Each message has turn, role, direction, via, at, text, source (ledger since go-live; history before it, with turn null and role user|assistant).' },
    { method: 'GET', path: '/threads/{id}/messages', query: 'limit=1-100 (default 20), before=<ISO time>', description: 'Page further back; pass next_before as before until it is null.' },
    { method: 'POST', path: '/threads/{id}/reply', body: '{expected_turn, text}', description: 'Post into the thread as James. 409 stale_turn if behind, 409 thread_archived if archived (reopen first).' },
    { method: 'POST', path: '/threads/{id}/close', body: '{expected_turn?}', description: 'Mark done. Done threads archive themselves after 7 quiet days.' },
    { method: 'POST', path: '/threads/{id}/archive', body: '{expected_turn?}', description: 'Archive (nothing is deleted). 409 thread_working while Veneer is mid-reply.' },
    { method: 'POST', path: '/threads/{id}/reopen', body: '{expected_turn?}', description: 'Back to open, and unarchive the chat.' },
    { method: 'POST', path: '/threads/{id}/follow', body: '{follow: true|false}', description: 'Follow or unfollow any thread. Followed threads push every Veneer reply to the webhook.' },
    { method: 'GET', path: '/bots', description: 'Active registered bots (Sage, Piper, Finn, Boris, AutoShip Worker, OrderOps Runtime Custodian, ...) with name, project, business_team and their standing chat as a thread.' },
    { method: 'POST', path: '/bots/{bot}/message', body: '{text, expected_turn?}', description: 'Message a bot in its own standing chat. {bot} is the name (case-insensitive, URL-encoded) or chat id. Only the bot\'s reply to this message is pushed to the webhook (its other traffic is not), unless you follow that chat.' },
    { method: 'POST', path: '/test-push', body: '{thread_id, simulate_webhook_failure?}', description: 'Send a test push for a thread now; simulate_webhook_failure exercises the email fallback.' },
  ],
  webhook: {
    request: 'POST JSON to JAMES_WEBHOOK_URL with Authorization: Bearer <JAMES_WEBHOOK_KEY>, X-Veneer-Signature: sha256=<HMAC-SHA256 of the raw body keyed with JAMES_WEBHOOK_KEY>, Idempotency-Key: veneer-james-push-<push_id>.',
    types: {
      'veneer.thread_update': 'thread, reasons (reply, question_unanswered, quiet, status_changed, test), events with excerpts (answers_james marks a bot reply to your message), reply_with.body.expected_turn.',
      'veneer.heartbeat': 'Daily 8:30 AM ET: counts and the waiting_on_james, waiting_on_veneer and open lists of your threads.',
    },
    rules: 'At most one push per thread per 15 minutes. Two failed POSTs send the same alert by email to nicks@mail.grokbot.com (then nick@elkhartrvparts.com). Replying to that email with CLOSE or ARCHIVE as the first word acts on the thread.',
  },
  message_format: 'Your posts reach the chat as "[James link · thread <id> · turn <n>]" then "From James (direct, no Nick relay): <text>".',
} as const;
