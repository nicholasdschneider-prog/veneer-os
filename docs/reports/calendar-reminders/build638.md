# Archer conversational calls — build 638

October 7, 2026. Active queue receipt: **#638**, Veneer OS only. Prior #629 commit
`6f9475d38e4523ebef0c432637a8e6a4015552e3` remains historical; ERVP #628 is unrelated and skipped.
Owning Archer chat: `f4131f81-27c5-4332-902a-a0d9873dfeb9`.
Originating investigation: `9443c42b-903e-47f8-b48c-948a9b126d87`.

## Result and limits

Archer initiates non-decision calls through `request_bot_call`, using his existing
LiveVoice worker, Cedar voice, original chat context and Nick’s working phone connection.
Calendar reminders use that same path. The staged static speech adapter has been retired.
All bot call openings are interruptible; recording an answer or changing topics does not
end the conversation. Explicit new instructions go through the existing durable
`send_message`/voice-dispatch handoff to the original bot chat. Repeated transport delivery
of the same instruction ID posts once. Existing source, executor, tool and business
approval guards still apply. The phone voice does not execute business tools or claim
that its promises completed work.

**Preparation only:** no restart, deployment, installer run, owner activation or live
call occurred. New policies and calendar activation default off. Existing phone settings
and decision calling were not toggled by this build. No new bot or Google credentials were
created, borrowed or exported. No invitations, event recreation, customer calls or fake
decisions. Nick’s street address never supplies an event location. This is not a promise
of a call today.

## Exact deployment approval request

Approve deployment of this verified build by running **`npm run restart` from the Veneer OS
root** after its committed typecheck, full tests and build pass. This loads migration 0159
and the updated existing web/runner voice/MCP paths. No installer change is required.
That approval does not authorize a live test call or automatically enable calendar calls.
Deployment is withheld because the active task explicitly authorized staging and synthetic
tests only. Nick’s original 20-minute meeting-reminder instruction is already retained;
no duplicate business reminder consent is requested.

## Actual owner technical setup after approved deployment

1. In the existing question desk **Calls** settings, retain Nick’s phone
   **+15743708714**, **Call my phone** and Archer under **Bots that can call me**.
   The working AutoShip telephone connection is reused; no second telephony account
   or calendar token-custody service is required.
2. Turn on **Archer can call about his work**. This owner-only control permits the
   original Archer to use the new non-decision interface for grounded, authorized work.
   Ordinary calls honor calling hours, do-not-disturb and the existing six-per-hour cap.
   No arbitrary recipient, customer calling or unsolicited routine is enabled.
3. Choose **Prepare my connected calendars**. The backend reads Archer-accessible,
   owner-personal Google Calendar installations through the existing Composio SDK.
   Authenticated current-user reads must match exactly `nick@mphealth.net`,
   `nick@elkhartrvparts.com`, and `nicholasdschneider@gmail.com`.
   Display names never establish identity. Review the returned complete calendar IDs
   and manifest hash under **Review calendar setup**. Preparation places no call.
4. Choose **Enable Archer calendar calls**. The server rechecks identities, complete
   calendar inventory, original connection fingerprints and existing phone policy.
   It binds that exact manifest hash and existing connection pins. Calendar calls use
   the actual phone even while Nick is in Veneer, 20 minutes before timed confirmed
   meetings in **America/Indiana/Indianapolis**, including outside ordinary calling
   hours. **Do not disturb**, the Archer policy, phone toggle and hourly cap still
   block calls. **Pause calendar calls** disables scheduling without erasing attempts.

These are concrete technical controls, not a request to repeat reminder consent.
The UI/API cannot be used before this staged source is deployed. Existing account presence
was established in the originating investigation; this build did not perform live connector
reads or telephony tests. Exact runtime tool response compatibility and actual audio remain
unmeasured until separately authorized use. Missing or changed connection scope fails closed.
An already prepared incompatible #629 manifest remains immutable and requires a reviewed
technical amendment; no automatic migration erases history or infers a new source ID.

## Scheduling and attempt evidence

- Existing background service polls every **30 seconds**, with one active pass and
  shutdown cancellation. No separate bot, queued agent routine or backup wakes.
- Read-only Google tools are pinned at **20261001_00**: current user, list calendars,
  list events and get event. Existing owner service credentials are read only at use
  time. Requests have a 10-second abort; inventory has page, calendar and event bounds.
- Expanded recurring instances use **iCalUID + original occurrence**, independent of
  rescheduled start. Matching cross-account copies consolidate. Differing UID aliases
  require an authenticated alias producer: current connector transport fails closed for
  these aliases and never infers them from names/times or owner-supplied prose.
- Every copy is directly re-read for cancellation/reschedule immediately before
  provider entry, after voice setup. Evidence is at most **15 seconds** old; the
  finite due window is **two minutes** after the target reminder time. Expired entries
  are permanently skipped, without catch-up calls.
- Occurrence/ref reservation and **UNKNOWN** are durable before any external dial.
  There is no missed-reminder redial, rekey, replay or lease reaper. A failed or lost
  provider response keeps the original fence.
- All phone paths share durable user/destination reservations. Local hangup does not
  release a dispatched slot. Only authenticated exact terminal provider status releases
  shared call occupancy; original reminder/outbound purpose fences remain permanent.
  A lost provider SID stays UNKNOWN. Legacy in-flight rows without a retained destination
  block new phone reservations; the build does not invent a destination or erase them.
- Ordinary decision-call retries remain separate. A decision call is still a normal
  conversation; answer authority is bound to the existing exact decision/version.

The original confirmed event references are retained as reference evidence only:
`079h3db3qtj1a3kgb3894beocc` (MPHealth Oct 7, 12:30–13:30 ET, target 12:10) and
`uipr3lhj2jserucs8llfr3b82c` (ERVP Oct 8, 13:00–15:00 ET, target 12:40).
Neither ID was recreated, scheduled through a fake decision, or called by this build.

## Shared source artifact pin

The full suite detected that the new `request_bot_call` entry changes the shared
`server/src/mcp/botTools.ts` bytes pinned by the existing customer-email artifact manifest.
The reviewed source hash was regenerated without changing its protected file inventory,
customer-email authority logic or any live registry/enrollment. Old acceptance stays tied
to its old hash and is not renewed or transferred. The exact previous/new hashes and
ordered file evidence are retained in [shared artifact delta](/Users/archerclawdington/veneer-os/docs/reports/calendar-reminders/build638-shared-artifact.json).

## Synthetic validation

Required root `npm run typecheck` passed. Full root `npm test` passed:
30 installer tests; 286 server files with 3,756 passed and 15 existing skips;
146 web files with 1,013 passed; 51 browser-manager tests, no failures.
The subsequent two calendar-to-Archer bridge cases passed as part of the 16-test
outbound suite. Final scoped checks also passed: 126 phone/calendar/guide tests,
202 voice/customer-email regression tests and 42 calendar/outbound readiness tests.
Root `npm run build` passed (server TypeScript/migration copy and web TypeScript/Vite).
Vite emitted its existing bundle-size advisory; no build failure. No restart followed.

The worker accepts the legacy decision-call IPC opening when an existing parent has
not yet restarted; new parents explicitly distinguish decision and reminder openings.
This keeps existing decision tools compatible during the authorized build-before-restart
process. The new source worker/policy is activated only by the separately approved
parent-service deployment and owner controls.
Fixtures use isolated in-memory databases, fake phone providers and synthetic connector
installs. They prove original identity/voice/chat routing, one durable instruction delivery,
owner and phone-policy rejection, no fake decisions, shared occupancy, provider UNKNOWN
fencing, exact terminal readback after interruption, cancellation during setup, due expiry,
recurring/cross-account consolidation, bounded disabled scheduling and read-only connector
identity selection. Existing employee access and fresh/resumed-agent catalog delivery are
covered by the feature-guide regressions. New owner UI labels and normal-conversation
policy are covered by web rendering tests. No live audio, real SDK account responses or
production scheduling readiness is claimed from these fixtures.

## Changed files

- [docs/bot-calls.md](/Users/archerclawdington/veneer-os/docs/bot-calls.md)
- [docs/bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md)
- [docs/reports/calendar-reminders/build638.md](/Users/archerclawdington/veneer-os/docs/reports/calendar-reminders/build638.md)
- [server/src/botWorkflows/background.ts](/Users/archerclawdington/veneer-os/server/src/botWorkflows/background.ts)
- [server/src/bots/botCalls.ts](/Users/archerclawdington/veneer-os/server/src/bots/botCalls.ts)
- [server/src/bots/outboundCalls.ts](/Users/archerclawdington/veneer-os/server/src/bots/outboundCalls.ts)
- [server/src/bots/routes.ts](/Users/archerclawdington/veneer-os/server/src/bots/routes.ts)
- [server/src/calendarReminders/connectorReader.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/connectorReader.ts)
- [server/src/calendarReminders/googleReader.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/googleReader.ts)
- [server/src/calendarReminders/phone.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/phone.ts)
- [server/src/calendarReminders/service.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/service.ts)
- [server/src/calendarReminders/worker.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/worker.ts)
- [server/src/db/migrations/0159_conversational_outbound_calls.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0159_conversational_outbound_calls.sql)
- [server/src/featureGuide/catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [server/src/mcp/botTools.ts](/Users/archerclawdington/veneer-os/server/src/mcp/botTools.ts)
- [server/src/routes/botCalls.ts](/Users/archerclawdington/veneer-os/server/src/routes/botCalls.ts)
- [server/src/routes/calendarReminders.ts](/Users/archerclawdington/veneer-os/server/src/routes/calendarReminders.ts)
- [server/src/voice/phoneReservation.ts](/Users/archerclawdington/veneer-os/server/src/voice/phoneReservation.ts)
- [server/src/voice/service.ts](/Users/archerclawdington/veneer-os/server/src/voice/service.ts)
- [server/src/voice/worker.ts](/Users/archerclawdington/veneer-os/server/src/voice/worker.ts)
- [server/test/botCalls.test.ts](/Users/archerclawdington/veneer-os/server/test/botCalls.test.ts)
- [server/test/calendarReminders.test.ts](/Users/archerclawdington/veneer-os/server/test/calendarReminders.test.ts)
- [server/test/liveVoiceService.test.ts](/Users/archerclawdington/veneer-os/server/test/liveVoiceService.test.ts)
- [server/test/outboundCalls.test.ts](/Users/archerclawdington/veneer-os/server/test/outboundCalls.test.ts)
- [web/src/components/ArcherCallSettings.test.tsx](/Users/archerclawdington/veneer-os/web/src/components/ArcherCallSettings.test.tsx)
- [web/src/components/ArcherCallSettings.tsx](/Users/archerclawdington/veneer-os/web/src/components/ArcherCallSettings.tsx)
- [web/src/components/BotCalls.tsx](/Users/archerclawdington/veneer-os/web/src/components/BotCalls.tsx)

- [docs/bot-calls.md](/Users/archerclawdington/veneer-os/docs/bot-calls.md)
- [server/src/bots/customerEmailArtifact.ts](/Users/archerclawdington/veneer-os/server/src/bots/customerEmailArtifact.ts)
- [docs/reports/calendar-reminders/build638-shared-artifact.json](/Users/archerclawdington/veneer-os/docs/reports/calendar-reminders/build638-shared-artifact.json)
