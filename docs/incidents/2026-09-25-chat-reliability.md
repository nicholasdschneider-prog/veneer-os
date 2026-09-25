# Chat reliability investigation — September 25, 2026

The reported break followed outgoing message timeline work at `20cb3e3`; inline
result replies were also suspected. At investigation time the live web and runner
health endpoint reported healthy. No inline rendering failure was reproduced.
The original user-visible symptom and its exact time were not supplied, so the
observed historical server crash cannot be conclusively assigned to this report.

## Findings and repair

- The web log contains an unhandled socket `read ECONNRESET` terminating Node.
  The main chat and speech WebSocket upgrade handlers had an unprotected interval
  while awaiting identity resolution. Other upgrade handlers already protected
  this interval. A server-wide connection error listener now destroys the affected
  socket without logging request data or terminating the service. This also
  protects future upgrade handlers attached to this server.
- Build #335 failed to dispatch with `database is locked`; the runner log also
  contains prior wakeup delivery lock failures. Incoming idempotent messages read
  their receipt in a deferred transaction before writing. With WAL, another
  service can commit between these operations, making the snapshot impossible to
  upgrade even with a busy timeout. Both inbound delivery paths now acquire the
  writer with `BEGIN IMMEDIATE` before the receipt read. Message and receipt stay
  atomic and duplicate prevention is preserved. A sustained writer lock can still
  time out; no automatic repeat of an uncertain external action was introduced.
- The existing timeline browser check supplied no inline replies. Its fixture now
  returns an actual inline reply and asserts that it renders alongside outgoing
  cards. This closes a gap in coverage rather than proving the suspected UI cause.
- Read-only aggregate checks found no invalid JSON/anchor shapes or missing source
  text in the 22 stored result threads (35 replies), and no missing creation times
  in the 44 outgoing drafts. No customer content was copied into test fixtures.
- The shell's default Node 22 executable cannot load its simdjson library. All
  validation uses the supported Node 24 at `/opt/homebrew/opt/node@24/bin`.
  Production already uses Node 24; the shell issue was not treated as its cause.

## Regression coverage

The socket test injects ECONNRESET on a real upgraded connection before WebSocket
ownership, verifies it closes, and requests a healthy response on another
connection. The database test uses two file-backed WAL connections and injects a
competing write between receipt lookup and message insertion; it verifies one
receipt, duplicate suppression, and successful writes after the transaction ends.
The isolated browser fixture covers five widths in both themes, inline reply
rendering, draft chronology/editing, voice cards, history, and chat switching.

## Changed files

- [Connection guard](/Users/archerclawdington/veneer-os/server/src/channels/connectionErrors.ts)
- [Web server integration](/Users/archerclawdington/veneer-os/server/src/index.ts)
- [Inbound transaction fix](/Users/archerclawdington/veneer-os/server/src/runtime/conversationManager.ts)
- [Socket regression test](/Users/archerclawdington/veneer-os/server/test/connectionErrors.test.ts)
- [Database concurrency regression test](/Users/archerclawdington/veneer-os/server/test/buildDispatchIdentity.test.ts)
- [Timeline browser fixture](/Users/archerclawdington/veneer-os/scripts/voice-timeline-browser-check.mjs)
- [This incident report](/Users/archerclawdington/veneer-os/docs/incidents/2026-09-25-chat-reliability.md)

Validation before restart passed: root typecheck; all 21 installer tests, 2,480
server tests (5 skipped), 896 web tests, and 40 browser-manager tests; production
build. The expanded browser fixture passed all ten width/theme combinations.

## Deployment verification

Commit `9324cb8` was pushed to `origin/main`. The root restart replaced web and
runner at 13:05 EDT and interrupted the executing chat. On continuation, process
start times and `/healthz` confirmed both replacements were healthy. The remaining
app-runner, terminal, and browser-manager restarts were completed through the
root `npm run restart -- ...` command, which reported each service healthy.
The final web health response reported `ok: true`, web healthy, runner healthy.
The compiled server contains the connection guard and immediate transactions.
No inline-rendering failure was reproduced; confirmation of the originally
reported user-visible symptom remains unavailable.
