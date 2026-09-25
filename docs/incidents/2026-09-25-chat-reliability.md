# Chat reliability investigation — September 25, 2026

The reported break followed outgoing message timeline work at `20cb3e3`; inline
result replies were also suspected. At investigation time the live web and runner
health endpoint reported healthy. No inline rendering failure was reproduced.
The symptom was initially unavailable; the subsequent human reply and tunnel
findings are recorded below. The historical server crash still cannot be
conclusively assigned to the original report.

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
No inline-rendering failure was reproduced. The follow-up below records the
subsequently read human description of the outage.


## Follow-up: public outage evidence and verification repair

The human described chat-thread 502s, inability to reply, VeneerBots failing, then
a Cloudflare tunnel error across the site. Tunnel logs distinguish several events
on September 25 (EDT; UTC is four hours later):

| Time | Evidence |
| --- | --- |
| 12:44:24 | macOS kernel boot time, checked with `sysctl -n kern.boottime`; reboot cause unknown. |
| 12:45, 12:48 | Cloudflared could not connect to the local web origin. |
| 12:51–12:52 | QUIC timeouts, followed by tunnel registrations. |
| 12:59–1:04 | Another edge outage; explicit `sendmsg: no route to host` at 1:01–1:02. First connection recovered at 1:02:16; all four registered by 1:04:06. |
| 1:05:40–41 | Local origin refusals during our known deployment restart. |

The network failures are independent evidence missing from the first investigation.
They establish lost host-to-edge connectivity, not its cause: no claim is made
about a router, VPN, ISP, or the inline thread feature causing it. The current
host has a default route and the tunnel reports four active connections. Two
cloudflared processes run here, on separate metrics ports, which makes a blind
check of the default metrics port unsafe as recovery evidence.

The old boot probe called an unauthenticated Access redirect “up and protected”
and labeled it a tunnel check. That inference was incorrect. The new read-only
`npm run health` command and post-restart verification separate local services,
Veneer's own tunnel readiness, and public front-door reachability. Boot reports
make the same distinction. Unknown/disconnected configured tunnels fail even if
the public login page returns 302. All reports explicitly leave authenticated
end-to-end chat unverified; no credentials or borrowed sessions are used.

Readiness follows [Cloudflare's readiness implementation](https://github.com/cloudflare/cloudflared/blob/master/metrics/readiness.go):
a successful `/ready` response reports active edge connections. Dynamic metrics
ports are described in [Cloudflare's metrics documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/).
Discovery uses the log-owning process and its loopback listener rather than a
hardcoded port. No authentication, tunnel transport, DNS, or network configuration
was changed. These bounded checks do not add a background monitor or restart loop.

Follow-up files:

- [Tunnel diagnostics](/Users/archerclawdington/veneer-os/scripts/tunnel-health.mjs)
- [Diagnostic regression tests](/Users/archerclawdington/veneer-os/installer/tunnel-health.test.mjs)
- [Restart verification](/Users/archerclawdington/veneer-os/scripts/restart.mjs)
- [Boot verification](/Users/archerclawdington/veneer-os/scripts/boot-probe.mjs)
- [Health command](/Users/archerclawdington/veneer-os/package.json)
- [Operator instructions](/Users/archerclawdington/veneer-os/README.md)

Follow-up validation passed before restart: root typecheck, 29 installer tests
(including 8 tunnel diagnostic tests), 2,480 server tests (5 skipped), 896 web
tests, 40 browser-manager tests, and production build. Live `npm run health`
reported healthy local web/runner, four connections on the owned tunnel, and
HTTP 302 public front-door reachability with authenticated chat unverified.

Follow-up deployment: commit `7250de5` was pushed to `origin/main`. The root
restart completed all five services and ran the new connectivity checks. On
continuation, another `npm run health` exited successfully: local web/runner
healthy, four active connections on Veneer's tunnel, and HTTP 302 from the public
front door. Authenticated public chat remains explicitly unverified.

## Follow-up: 4:00 PM outage — host network loss, not a Veneer crash

No Veneer process crashed. launchd reports every service on its first run since
the 16:06 deployment with no abnormal exits, and there are no Node crash reports
for today. The only diagnostic reports are macOS disk-write and CPU advisories
(the 16:06 backup job and the web server), neither of which terminates a process.

| Time (EDT) | Evidence |
| --- | --- |
| 16:00:20 | All four QUIC edge connections time out together. |
| 16:01–16:02 | `sendmsg: no route to host` to Cloudflare, DNS lookups time out. |
| 16:02:09 | First connection re-registers; all four by 16:03:05. |
| 16:03:30–41 | Second brief drop; reconnects in 11 seconds. |
| 16:04:55, 16:06:48 | Manual tunnel restart, then the HTTP/2 deployment (`92c4b7b`) briefly refused origin requests. |

An unrelated tunnel on this Mac (`com.outpost.cloudflared`, its own token and
log) failed and recovered at the same times, as it did at 12:51 and 12:59–13:03.
The Mac lost its default route, so the fault is below Veneer: the Wi-Fi link
(en1, 5 GHz channel 36, gateway 10.0.1.1). Built-in Ethernet (en0) and the
AX88179A USB adapter (en8) are both ahead of Wi-Fi in the service order but have
no cable link. A later 40-packet gateway ping showed no loss.

The steering deployment (`cb01a0b`, chat 5d4122c1) was checked as a suspect and
ruled out. Its restart at 15:51:44 refused origin requests for under one second,
eight minutes before the loss. Its work ended at 15:52:13 and ran no network,
DNS, or routing commands. After the restart, turn counts, stops, and pending turns
stayed normal. Restarts at 14:07, 14:26, and 14:57 were not followed by network
loss, and the 12:51 and 12:59 losses had no restart before them.

Cloudflared recovered on its own within a minute of the route returning each time,
so no watchdog or restart loop was added; it could not help while the host has no
route. Pinning HTTP/2 (`92c4b7b`) keeps TCP recovery behavior but does not prevent
the loss. The durable fix is a wired Ethernet cable to en0 or en8; macOS will
prefer it automatically and keep Wi-Fi as fallback. Check with
`route -n get default | grep interface` (expect `en0` or `en8`).
