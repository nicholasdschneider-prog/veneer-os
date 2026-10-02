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

## Phase one — browser calls (built 2026-10-02, build #539)

How it works:

- **Settings** live in the raised-hand desk under **Calls**: do not disturb, calling hours, and one
  switch per bot. Every bot starts off for every person. `bot_call_settings`, `bot_call_bots`.
- **Who is called.** A bot rings each person who turned it on *and* can already answer the question.
  There is no separate routing table: customer service bots ring Ali because Ali has them on and Nick
  does not. Turning a bot on grants no access.
- **Ring engine** (`server/src/bots/botCalls.ts`, table `bot_call_rings`). One ring per person at a
  time, taken from the question line's fair order. 25 seconds, then missed; retried every 15 minutes
  with no cap; a 60 second pause after any ring or call; never during a live call. Reminded
  ("Later") and stale questions do not ring. It runs on every open tab's check-in and on the
  5 second background pass.
- **Calling window.** 08:00–18:00 America/New_York by default (editable per person), or within
  5 minutes of real input in an open Veneer tab.
- **Ring card** (`web/src/components/BotCalls.tsx`): bot name, the question, a ringtone, Answer and
  Decline. Answer opens the existing live call on that question and connects without another press.
- **Phone.** If the person has not touched Veneer in the last minute, their registered devices get a
  push naming the bot. Tapping it opens Veneer and rings again there; Answer is one more tap.
- **The call.** The bot says its name and the question in one sentence and waits. On an answer it
  repeats it back, records it through the existing answer tools and hangs up (`end_call`). On
  "I can't do that now" it calls `stop_calling`: no answer is recorded, the card stays, and that
  question never rings again. A call that ends any other way is retried after 15 minutes.
- **Voice training.** Saved voice preferences (length, tone, structure) apply to these calls. Only
  the saved greeting is replaced, by the plain-question opening.

Known browser limits: a ringtone cannot play in a tab that has not been touched since it loaded, and
a locked iPhone shows a notification rather than ringing.

## Phase two — real phone call (only if phase one proves useful)

Bots dial the person's cell through Twilio or similar, bridged into the same LiveKit voice session,
so the phone rings on the lock screen and AirPods can answer. The bot waits to hear the person
before reading anything, so a question is never read into voicemail. Needs a calling account and
number; OrderOps already uses Twilio.

## Voice problems seen during the interview

- **A call ended on its own after 41 seconds** (2026-10-02 17:26:46Z–17:27:27Z). The session record
  shows the browser ended it (`outcome=ended`, last heartbeat 6 seconds earlier), not the server or
  the voice worker; which browser event did it was not recorded, so the cause is still unknown.
  Changes: every call now records why it ended (`voice_sessions.end_reason` and a `[voice] call …`
  log line); one failed status check or heartbeat no longer hangs up (three in a row do); and a
  microphone that drops out, as when AirPods switch devices, is re-acquired instead of ending the
  call.
- **The voice line repeated itself and talked over the caller.** Turn detection moved from a fixed
  silence timer to semantic detection, which waits for a finished thought; background-reply notices
  now wait for a 2.5 second lull; and the voice rules forbid repeating a sentence or restarting
  after a filler sound. Not yet confirmed on a real call.
