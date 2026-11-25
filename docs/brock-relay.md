# Brock relay

Optional relay of Tess's needs-Nick CS decision cards to the Grok Bot "Brock" (Customer Service
Manager, Grok Bot agent id 5013eed8-dc7f-4a29-af62-a8f87d6e44b3), so Nick gets an iOS notification.
Nick approved it on 2026-11-25. Code: `server/src/brockRelay/`, migration `0201_brock_relay.sql`.

- Tess stays the sole case owner. Brock only relays. He never works tickets, never replies to
  customers and never touches OrderOps.
- The Veneer web cards work unchanged. The first answer wins, from either side.

## Settings

All settings are Doppler secrets in main/prd. The web service refreshes them without a restart.

| Key | Meaning |
|---|---|
| `BROCK_RELAY_MODE` | `off` (the default when unset), `test` (only cards from the test chat) or `live` (Tess, plus the test chat) |
| `BROCK_RELAY_WEBHOOK_URL` | Brock's Grok Bot routine webhook trigger URL (https only) |
| `BROCK_RELAY_WEBHOOK_SECRET` | Shared secret (24+ characters) |
| `BROCK_RELAY_TEST_CHAT_ID` | The registered dummy bot chat "Brock Relay Test" |
| `BROCK_RELAY_BOT_CHAT_IDS` | Optional comma list of bot chats to relay. The default is the active registration named Tess. |

A card is relayed when all of these hold:
- its bot chat is in scope for the mode;
- its assignee is the owner (Nick);
- it is waiting for an answer and not stale;
- the bot registration is active.

File links are built on `VP_APPS_PUBLIC_ORIGIN` (`https://nicksworld.dev`).

## Push (Veneer to Brock)

Veneer POSTs JSON to `BROCK_RELAY_WEBHOOK_URL` within about 5 s of any change. The headers use the
same scheme as the James push:

- `Authorization: Bearer <BROCK_RELAY_WEBHOOK_SECRET>`
- `X-Veneer-Signature: sha256=<hex HMAC-SHA256 of the raw body with the secret>`
- `X-Veneer-Event: card.raised | card.resolved`
- `X-Veneer-Event-Id` and `Idempotency-Key: veneer-brock-evt-<n>`. Delivery is at least once, so the
  receiver should dedupe on this value.

Delivery details:
- A durable outbox (`brock_relay_outbox`) sends events in order.
- Retries back off at 30 s, 2 m, 10 m, 30 m, 2 h, 6 h and 12 h. An event is given up after 12
  attempts, or after 3 attempts on a 4xx other than 408 or 429.
- A card that resolved before its raise could be delivered is never sent, and neither is its resolved
  event.
- A revised card sends `card.resolved` (`superseded`) for the old version, then `card.raised` for
  the new one.

`resolution` is one of these values:
- `answered`, with `answered_via` set to `grokbot_brock` or `veneer`;
- `withdrawn` (by Tess);
- `expired` (withdrawn automatically);
- `stale` (the case changed; Tess will revise or withdraw);
- `superseded`, with `superseded_by_version`;
- `unrelayed` (reassigned or out of scope).

Attachments are signed links, valid 7 days. A link stops working 1 hour after its card version
resolves. Fetching one needs no login. Each link returns the file bytes with its real
`Content-Type`. They cover:
- card images;
- retained card evidence (customer photos, PDFs, Gmail attachments) and files a human added;
- mirrored ticket-thread attachments;
- the proposed reply's attachments.

A file Veneer cannot fetch is listed with `url: null` and an `unavailable_reason`.

## James API: `/api/james/brock`

Every endpoint except the file links needs `Authorization: Bearer <VENEER_JAMES_API_KEY>`. They return
404 `brock_relay_off` while the mode is off.

- `POST /answer`
  - Headers: `Idempotency-Key` (required).
  - Body: `{card_id, expected_version, answer_text, answered_via: "grokbot_brock"}`.
  - The answer is recorded as Nick's own typed answer ("Something else"), exactly as on the web
    card, and Tess is woken to continue.
  - 200: `{ok, card:{card_id, version, state:"decided", answered_via, answered_at, answer_text}}`.
  - 409 `already_resolved`, `version_mismatch`, `stale` or `not_relayed`, each with the current
    `card` state. On a 409, Brock withdraws his copy and does not ask again.
  - 404 `card_not_found`; 400 `idempotency_key_required` or `invalid_body`.
  - A replay with the same key and body returns the stored response with `Idempotent-Replay: true`.
- `GET /cards`: cards currently active on Brock.
- `GET /cards/{id}`: the current card with freshly signed file links, or `card: null` once it has
  resolved.
- `POST /test-card {with_attachments?}`: raises a dummy card (with a PNG and a PDF) in the test chat.
  It involves no customer, ticket or order.
- `GET /files/{token}`: a public signed file link.
