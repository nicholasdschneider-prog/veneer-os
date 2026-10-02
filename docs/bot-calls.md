# Bot calls — operating procedure and phase one plan

Decisions from the owner interview on 2026-10-02. A bot with a question tries a live voice call
first; the question card in the desk line stays the durable record and the fallback.

## Rules

| Topic | Decision |
|---|---|
| Record of truth | The question is always raised as a card first. A call is only a faster way to answer that card. |
| Who may call | Per-bot "can call me" toggle in the desk pop-up, plus a master do-not-disturb. Each person has their own settings. |
| New bots | Calls off until the person turns them on. (Assumed; not confirmed by the owner.) |
| When | 8 a.m.–6 p.m. Eastern every day, or any time the person is active in Veneer. |
| Busy | Never ring someone already on a call. (Assumed; not confirmed by the owner.) |
| Who is called | Each bot calls one person first: customer service bots call Ali, Clara calls Mackenzie, AutoShip Worker calls Nick. No automatic escalation to Nick. |
| Opening | The bot asks the question plainly, with no lead-in. Background and recommendation only when asked. |
| Answer | Short repeat-back, record the answer, hang up. The bot then continues its work. |
| "I can't do that now" | Hang up, leave the card in the line with its evidence, and never call again about that question. |
| Stacking | One bot and one question per call, one call at a time. The next bot may ring after a short pause. |
| Missed call | Ring 25 seconds. Retry every 15 minutes with no cap, inside the calling window, until answered or told "I can't do that now". |
| Voice limits | None: anything approvable on a card is approvable by voice. Existing approval and execution guards are unchanged. |
| Training | The person tunes how the voice behaves by telling it on a call (saved voice preferences) or by telling Platform Dev in chat. |

Tune-down levers if calls become too frequent: cap retries, lengthen the retry gap, or switch to one
call that walks through every waiting bot.

## Phase one — browser calls

- Desk bubble rings (bot name, one-line question, Answer / Decline) on desktop and on the iPhone
  while Veneer is open. One tap on Answer opens the existing live call focused on that question.
- When Veneer is not open on the phone, a push notification is sent; tapping it opens the call.
- Ring state is tracked on the server so two tabs or devices do not both ring, and so retries,
  "can't do that now" and the calling window are enforced in one place.
- Known browser limits: a ringtone cannot play in a tab that has not been touched since it loaded,
  and a locked iPhone shows a notification rather than ringing.

## Phase two — real phone call (only if phase one proves useful)

Bots dial the person's cell through Twilio or similar, bridged into the same LiveKit voice session,
so the phone rings on the lock screen and AirPods can answer. The bot waits to hear the person
before reading anything, so a question is never read into voicemail. Needs a calling account and
number; OrderOps already uses Twilio.

## Voice problems seen during the interview (to fix with phase one)

- A call ended on its own after 41 seconds (2026-10-02 17:26:46Z–17:27:27Z); the service logs show
  no error. The voice worker closes the session as soon as the participant disconnects, so a brief
  network blip is a likely but unverified cause.
- The voice line repeated the same sentence twice and talked over the caller several times.
