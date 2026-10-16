# Miles ticket pilot (build #866) — before / after

Directed by Nick, voice call 2026-10-16: one bot (Miles) owns customer tickets start to finish inside Veneer; every other CS bot keeps working through OrderOps as is. Modeled on John Webber's bot page → Tickets tab → self-contained question card with Remember.

## Before
- Customer tickets live only in OrderOps (Railway). Each bot turn re-fetches the thread over the API through the bot's own login; the human's card shows a summary and points at OrderOps.
- Miles (chat 8540bd53…, ERVP, codex gpt-6.1-sol) has no routines; the half-hour CS queue trigger and humans wake him. Several bots share the pool with no ownership record in Veneer.
- Veneer has no server-side OrderOps client; OrderOps only pushes event ids (ticket.created / customer.replied) to the OrderOps event source 90ef6920.

## After (this build)
- `cs_tickets` / `cs_ticket_messages` / `cs_ticket_owners` (migration 0185; Miles seeded). `bot_decisions.cs_ticket_id` links questions to tickets.
- Tools for enrolled owners: `sync_cs_ticket` (copy or update a ticket; first sync opens the ticket chat and wakes it), `set_cs_ticket_status`, `add_cs_ticket_note`.
- Ticket chat = coordination lane of Miles's chat (same identity, skills, tools, connectors); visible where Miles is; the full ticket record is injected every turn; dedicated lane rules instead of the generic coordination-thread text.
- Wakes scheduled on Miles's chat with `cs-ticket:` keys, and decision answers for ticket-bound questions, run in the ticket chat (`wakeTarget`). OrderOps events for a mirrored ticket wake the ticket chat and skip Miles's routine.
- `raise_decision` from a ticket chat auto-fills `as_of.ticket_id`, binds the decision, sets status waiting_human; a human answer sets it back to open.
- Human UI: `#/bots/tickets/<botId>[/<ticketId>]` with Needs you / Waiting / Done / All, search, ticket detail (thread, orders, summary, open question card with choices, earlier questions, Open chat), note box with Send and Remember. Bots page row shows "Tickets · N" for enrolled owners; BotActions menu has Tickets.
- Catalog `cs-tickets-in-veneer` (guide + injected prompt); docs/bot-feature-guide.md section.

## Not in this build (and why)
- Server-side 10-minute OrderOps safety poll: no OrderOps client exists in Veneer. The ticket chat is told to schedule its own re-check wake while waiting on the customer; the half-hour CS trigger still runs.
- Marking the ticket assigned to Miles inside OrderOps: done by Miles through his own OrderOps access as part of taking the ticket (skill-level), not by the server.
- Activity (runs) list per bot: Veneer has no such list; each ticket row links Open chat to its ticket chat.
- Moving email/SMS ingestion out of OrderOps; changes to other bots; bot-count reduction.

## Pilot start (after deploy)
1. Nick or the half-hour trigger tells Miles to take a ParcelGuard ticket into Veneer; Miles calls `sync_cs_ticket` with the thread.
2. Open Bots → Miles → Tickets; confirm the thread and the first question card appear with the backstory.
3. Answer on the card; confirm the ticket chat wakes and continues. Leave a note with Remember; confirm Miles updates his skill.

## Validation
See the build report in the chat: root typecheck, full npm test, npm run build. Deployment pending a Nick-approved window (web + runner; migration 0185 applies on start).

## Build #868 — read-only OrderOps mirror (2026-10-16)
- Principal: see mirror-principal.md (veneer:ca80d9c1…, fingerprint c3d89115da56, Doppler ervp/prd ORDEROPS_TICKET_MIRROR_*).
- server/src/csTickets/poll.ts: GET-only allowlist (messages, capability), 2-minute cadence inside the bot background loop, 25 tickets per pass, 10 s timeout, per-ticket backoff 1/2/4/8/30 min, 15-minute pause on 401/403, credential cached 10 min and read via readSecretValue.
- Mapping from OrderOps cs_messages: inbound → customer, outbound → bot (api principal / ai) or human (staff); internal notes skipped; attachments by filename; SMS delivery status appended to outbound SMS bodies and refreshed when it changes.
- Migration 0186: cs_tickets.last_polled_at / last_poll_error; ticket page shows "Checked OrderOps Xm ago" and the last failure.
- Deployment pending the same window as #866 (web + runner; migrations 0185 + 0186).

## Build #872 — composer, tappable answers, short notes (2026-10-16)
- Ticket page note box is the BotComposer (attachments via /api/uploads, dictation, Live voice button); attachments ride on the human note (attachments_json) and reach the ticket chat as upload paths in the wake prompt.
- add_cs_ticket_note: optional choices (2–4 {label ≤60, note ≤300, recommended on at most one}); rendered as tappable buttons under the newest bot note, disabled once a human writes; a tap posts the choice note (request_key choice:<note>:<i>).
- Note style enforced: ≤1200 chars, obvious "REPLY TO" / hash-like ids rejected; lane rules + wake text + catalog prompt say three plain sentences and end with choices or raise_decision.
- Migration 0187: cs_ticket_messages.choices_json. Deployment pending Nick window (web + runner).
