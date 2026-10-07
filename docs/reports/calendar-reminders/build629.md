# Build #629 — Nick calendar phone reminders (staged)

This is preparation only in `/Users/archerclawdington/veneer-os`. The skipped ERVP
build #628 is unrelated. No service restart, install, deployment, activation,
live calendar fetch, owner enrollment or telephone call is performed by this work.

Nick's original direction in Archer is retained: “Call me 20 minutes before any
meeting to remind me, call me on my cell phone 5743708714 ok?” The sole destination
is +15743708714; time zone is America/Indiana/Indianapolis. Verified source account
names are nick@mphealth.net, nick@elkhartrvparts.com and
nicholasdschneider@gmail.com. This direction is business consent for reminders;
technical deployment/enrollment is a distinct pending step.

## Prepared implementation

- Human Nick owner-only `/api/calendar-phone-reminders/settings` and `/prepare`.
  `/enable` always refuses. Manifest must remain `enabled:false` and is immutable.
  Members, consultants, other owners and bot principals cannot prepare it.
- Read-only Google adapter checks verified account identity at use time, pins the
  entire account calendar inventory including hidden calendars, follows bounded
  pagination and expands recurring occurrences. New or unreadable calendars,
  malformed cancellation evidence and partial results block the pass.
- Cross-account copies consolidate by iCalUID and original recurring occurrence.
  One-off UID keys survive moves. Differing UIDs require disjoint, authenticated
  alias evidence; titles, times and owner-supplied prose are insufficient. The
  Google adapter refuses aliases until a dedicated authenticated producer is bound.
- Every known copy receives a fresh direct read and identity check before dispatch.
  Conflicting starts, cancellation, tentative status, deletion, reschedule or stale
  evidence prevents the call. All-day, declined, working-location, birthday,
  out-of-office and focus-time events are excluded. Timed default events qualify.
- A SQLite immediate transaction persists one occurrence attempt and reference
  fences before provider entry. UNKNOWN is durable before the telephone POST.
  Lost responses, exceptions, crashes and missed calls never trigger redial/rekey.
  ACCEPTED is provider acceptance, not delivery; only exact authenticated terminal
  readback releases its phone lock. UNKNOWN never releases the lock automatically.
- One durable reminder phone lock; shared phone busy check; 30-second minimum poll
  spacing with no overlapping pass, 24-hour lookahead/history, at most 2,000 events
  per account, 10 pages per calendar/inventory, and a 2-minute due window. Expired
  observed occurrences become permanently SKIPPED, without catch-up calls.
- Static TwiML speaks Nick's meeting start time and hangs up. It has no LLM,
  decision tools, voice-action channel, in-app ring, SIP installation or retries.
  Titles are deliberately omitted to avoid exposing confidential calendar details
  or interpreting event text as instructions. Nick's home address never enters
  the manifest, speech, event location or calendar writes. Provider ring timeout
  is 25 seconds and call duration cap is 60 seconds.

## Exact pending owner technical setup

The disabled preparation body has these exact fields; no token or credential field
is accepted. Genuine source/calendar IDs remain unavailable in this source task,
so no callable enrollment body with invented IDs is provided.

| Field | Required value |
| --- | --- |
| `ownerEmail` | Nick's actual signed-in owner email, one of the three pinned addresses |
| `phone` | `+15743708714` |
| `timezone` | `America/Indiana/Indianapolis` |
| `leadMinutes` | `20` |
| `enabled` | `false` |
| `policy` | `actual-phone-even-when-present;one-attempt;no-redial;all-hours;timed-confirmed-meetings-only` |
| `bindings` | Exactly three `{account, sourceId, calendarIds}` records, one per pinned account, distinct authenticated source IDs, complete actual calendar IDs |
| `verifiedAliases` | Empty array until an authenticated alias producer is accepted; otherwise disjoint `{occurrenceKey, refs, evidence}` records |

Alias `refs` are exact JSON tuples `[account, sourceId, calendarId, eventId]`,
produced by `meetingRef`. An evidence string alone does not verify a link; each
pass independently invokes the accepted source verifier, and the staged Google
adapter currently refuses all differing-UID aliases.

No setup request is executable yet. The source custody binding and atomic shared
phone mediation remain unaccepted, and there is no registered worker. The build
does not export Composio credentials, invent connector IDs or assume that an
existing bot connection grants a background reader custody. These are technical
implementation/acceptance requirements, not missing business consent.

1. Accept a dedicated original-owner reader binding for each of the three live
   Google accounts. It must deliver the existing owner's authorized token only at
   use time to Google; tokens never enter manifests, transcripts or SQLite. The
   fixed adapter supports Google Calendar REST with read-only scopes and verified
   account identity. Actual Composio connector custody/refresh must be integrated
   by its owning service; generic token export is not supported here.
2. Capture each actual immutable source ID and every calendarList ID with Nick's
   own account credentials. Pin complete inventory. Do not guess `primary` or
   replace missing IDs with the observed event IDs. Added calendars require a
   separately reviewed technical amendment; they never silently widen scope.
3. Accept atomic shared telephone reservation across reminders and decision,
   test-phone, hotline and live-voice paths. The staged reminder lock alone cannot
   serialize unrelated phone paths. A read-only busy check is not that acceptance.
4. Bind any genuine differing-UID alias producer to authenticated source evidence,
   if needed; otherwise use an empty alias list. Historical UNKNOWN fences survive
   all amendments, revocations, worker changes and account reconnects.
5. Nick reviews exact disabled manifest, its hash and pinned custody receipts.
   Human-only preparation does not activate calling. Policy is actual phone even
   with in-app activity, all hours, timed confirmed meetings only, one attempt,
   no redial, finite two-minute lateness window, and no customer/business actions.
6. After those implementations and synthetic tests, request Nick's approval for
   the exact commit/artifact installation and coordinated root restart. Separately
   approved activation must install a bounded worker, honor pause/revocation and
   mediate dispatch atomically; the current `/enable` denial must remain until then.

Prepared request to present when prerequisites are concrete: “May I deploy the
exact tested Nick reminder artifact and restart Veneer after source custody and
shared phone serialization are accepted, leaving calling disabled until you review
the technical enrollment?” This is deployment/setup approval, not duplicate consent
to the original reminder instruction. No request to approve a live call is implied.

## Synthetic verification

The isolated suite uses migrated in-memory SQLite, synthetic event IDs, fake
Google/Twilio transports and an ephemeral loopback HTTP server only. It checks
owner/bot denial, immutable disabled manifests, cross-account consolidation,
recurrence/moves, authenticated aliases, cancellation/deletion/reschedule,
incomplete identity/inventory, pagination, stale rechecks, expiry, busy calls,
pre-dispatch UNKNOWN, no replay across engine recreation, exact terminal
reconciliation, static speech and staged guide delivery. Validation results are
recorded after the checks complete; no synthetic receipt is evidence of live
calling, connector custody, deployment or readiness.

Confirmed actual events remain reference data only: MPHealth
`079h3db3qtj1a3kgb3894beocc`, October 7 12:30–13:30 Eastern (due 12:10), and ERVP
`uipr3lhj2jserucs8llfr3b82c`, October 8 13:00–15:00 Eastern (due 12:40). No attempt
or synthetic ledger entry is created for these actual IDs. Today's call is not promised.

API semantics follow Google's [events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
and [event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events),
and Twilio's [static Say verb](https://www.twilio.com/docs/voice/twiml/say).

## Reviewable source artifact

Validation completed with the required Node 24 toolchain:

- Root `npm run typecheck`: passed.
- Dedicated suite: 28 synthetic tests passed in the full server run; guide contract
  tests also passed, including employee catalog and fresh/resumed instructions.
- Root `npm test`: passed. Installer 29; server 3,716 passed and 15 skipped;
  web 1,009; browser manager 51. No live reminder/Google/Twilio transport was used
  by the new tests. Existing browser tests use their isolated synthetic profiles.
- Root `npm run build`: passed (existing Vite chunk-size warning only).
- No `npm run restart`, installation, service activation, real enrollment or live
  reminder call was run. The prepared commit is pushed to origin main; this is
  source publication only and is not permission to deploy or enable calling.

The exact source revision for the pending deployment review is the commit hash
in the completion receipt sent to Archer and the originating investigation.

| File | Purpose |
| --- | --- |
| [service.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/service.ts) | Disabled manifest, occurrence keys, bounded pass, permanent ledger, exact accepted-call reconciliation |
| [googleReader.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/googleReader.ts) | Read-only identity/inventory/event adapter; unbound custody; alias denial |
| [phone.ts](/Users/archerclawdington/veneer-os/server/src/calendarReminders/phone.ts) | Static speech adapter and exact terminal provider readback; unregistered |
| [0156_calendar_phone_reminders.sql](/Users/archerclawdington/veneer-os/server/src/db/migrations/0156_calendar_phone_reminders.sql) | Disabled preparation and permanent attempt/reference/phone-lock tables |
| [calendarReminders.ts](/Users/archerclawdington/veneer-os/server/src/routes/calendarReminders.ts) | Owner-only preparation API and unconditional activation refusal |
| [api.ts](/Users/archerclawdington/veneer-os/server/src/routes/api.ts) | Mounts preparation routes only |
| [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts) | Staged employee/fresh/resumed-agent instructions |
| [calendarReminders.test.ts](/Users/archerclawdington/veneer-os/server/test/calendarReminders.test.ts) | Isolated synthetic guard, route and adapter tests |
| [bot-feature-guide.md](/Users/archerclawdington/veneer-os/docs/bot-feature-guide.md) | Employee/agent staged release documentation |
| [build629.md](/Users/archerclawdington/veneer-os/docs/reports/calendar-reminders/build629.md) | This report, technical setup and pending approval scope |
