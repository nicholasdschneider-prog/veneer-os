# Protocol notes — Claude CLI wire format (verified)

Findings from the prototype build (M1-lite), verified against **Claude Code 2.1.200** on macOS,
Node 26. Everything below was observed live, not inferred.

## Spawn shape that works (PER_TURN strategy)

First turn of a conversation:

```
claude -p --session-id <uuid> \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-mode acceptEdits --disallowedTools Bash --allowedTools WebSearch WebFetch
```

Every later turn: same flags but `--resume <uuid>` instead of `--session-id <uuid>`.

- **Prompt via stdin as plain text** (write, then close stdin) is reliable. No `--input-format`
  needed for PER_TURN. A trailing-arg prompt also works but stdin avoids argv length/quoting issues.
  **Superseded for approvals:** the shipped adapter now uses `--input-format stream-json` with
  stdin kept open so `control_response` lines can be written mid-turn — see §Approval round-trip.
- **`--resume` preserves the session id** — the `system:init` and `result` messages carry the same
  `session_id`, and the same `~/.claude/projects/.../<sid>.jsonl` file is appended to. No fork
  (`--fork-session` exists for that). Continuity confirmed: content from turn 1 was recalled in
  turn 2, including across a full server restart.
- `--allowedTools WebSearch WebFetch` as separate variadic args parses fine.
- The turn's process exits 0 shortly after emitting `result`.

## Output stream (NDJSON, one JSON object per line)

Message types observed, in rough order:

| line | notes |
|---|---|
| `{"type":"system","subtype":"hook_started"/"hook_response",...}` | only when user-level hooks are configured; **must be skipped** (schema differs from init) |
| `{"type":"system","subtype":"init","session_id","cwd","tools":[...],"mcp_servers":[...],"model","permissionMode",...}` | first real message; confirms session id |
| `{"type":"system","subtype":"status","status":"requesting",...}` | progress noise, skip |
| `{"type":"stream_event","event":{...anthropic streaming event...},"session_id","parent_tool_use_id"}` | only with `--include-partial-messages`. `event.type` ∈ message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop. Text arrives as `event.delta.type == "text_delta"` |
| `{"type":"assistant","message":{"id","model","role","content":[...]},"parent_tool_use_id"}` | the complete message so far. **Arrives after the text deltas but BEFORE `content_block_stop`/`message_stop`** — don't assume ordering. One API message can produce several of these rows sharing `message.id` (text, then tool_use) |
| `{"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}` | tool results echo back as user-role messages on the stream |
| `{"type":"rate_limit_event","rate_limit_info":{...}}` | captured into the usage store (Settings meters). Carries only the single BINDING window per event, and omits `utilization` below the warning threshold (verified 2026-07-06) — the usage probe reads the `anthropic-ratelimit-unified-5h/7d-*` response headers instead for deterministic 5-hour + overall-weekly numbers |
| `{"type":"result","subtype":"success","is_error",false,"result":"...","session_id","usage":{...},"total_cost_usd",...}` | end of turn. `usage.input_tokens` EXCLUDES cache reads — for a human-meaningful number sum `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |

Quirks that bit / to remember:

- **Log-and-skip is mandatory.** Hook lines, `rate_limit_event`, and `system:status` all share the
  stream. New types appear across CLI versions; `parseWireLine` returns `{kind:'skip'}` for
  anything unrecognized instead of throwing.
- `parent_tool_use_id != null` marks sub-agent (Task) chatter — filter it from the top-level chat.
- The final `assistant` row and `result.result` both carry the full text; we emit `text_final`
  from the assistant row (there can be several per turn, interleaved with tool calls) and only
  usage from `result`.
- User-level `~/.claude` settings leak into spawned CLIs (hooks, MCP servers, plugins). Harmless
  for the prototype; a dedicated Linux user (per spec §15) isolates this in production.

## Session file (rehydration truth)

- Path: `~/.claude/projects/<key>/<sessionId>.jsonl` where `<key>` =
  `path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')` (same rule as Veneer's
  `claudeProjectKeyForCwd`).
- Written incrementally during the turn; safe to parse at any time.
- Row types observed: `queue-operation` (prompt enqueue), `user` (string content for typed
  prompts; array content for tool_results), `attachment`, `last-prompt`, `assistant`
  (array content: text / thinking / tool_use blocks; multiple rows share `message.id` — merge),
  `mode`, `file-history-snapshot`. Only `user` and `assistant` matter for the transcript; skip
  rows with `isSidechain: true`.
- Golden-file test: `server/test/fixtures/session.jsonl` is a real 2-turn session captured from
  this CLI version; `session.golden.json` is the expected normalized event output.

## Connecting a Claude subscription in-app (`claude setup-token`)

Productized the manual OAuth flow (Settings → Claude account). Verified against
**Claude Code 2.1.200** on macOS (Node 26) and re-verified on the droplet
(Ubuntu, Node 22). See `server/src/claude/setupToken.ts`.

- **`claude setup-token` REQUIRES a TTY.** A plain `spawn` (pipe stdio) makes it
  refuse/garble. The `script`-wrapper workaround does NOT help on macOS: `script
  -q /dev/null claude setup-token` itself needs a real TTY on its own stdin and
  dies with `tcgetattr/ioctl: Operation not supported on socket` when the parent
  stdin is a socket/pipe. **We use `node-pty`** (approach (a)) — it compiles
  cleanly from source on both macOS/arm64 (Node 26) and the droplet's Ubuntu
  (Node 22); `npm ci` builds it via node-gyp. This is the chosen, working
  approach.
- **The printed authorize URL wraps at the terminal width with NO spaces inside
  it.** Do not rejoin wrapped lines with a space — that corrupts the URL
  (`redir` + space + `ect_uri`). Split the (ANSI-stripped) output on whitespace
  and concatenate fragments up to and including the one carrying the trailing
  `state=` param (the last query param the CLI emits). `extractAuthorizeUrl()`
  does exactly this. URL host is `https://claude.com/cai/oauth/authorize?...`.
- **ANSI/OSC escapes and control bytes** litter the stream (banner art, cursor
  moves, bracketed-paste `\x1b[?2004h`). Strip them before parsing (`stripAnsi`).
- **The attempt is bound to the child's PKCE verifier and dies after ~10–15 min.**
  A late paste is useless. We hard-expire + kill at 9 min and keep at most ONE
  in-flight attempt (a second `start` cancels the first). `node-pty`'s `kill()`
  reaps the child (SIGHUP to the pty leader); confirmed no orphan processes after
  cancel/expiry.
- **node-pty `chdir` gotcha:** its spawn-helper `chdir()`s into the spawn cwd
  and, if the inherited `process.cwd()` isn't traversable by the running user,
  dies with `chdir(2) failed.: Permission denied` and emits no URL (hit this on
  the droplet when a verify harness ran from `/root` as `veneer`). The spawner
  pins `cwd` to `os.homedir()` to avoid it; the live service also runs with
  `WorkingDirectory=%h/veneer-pro`.
- The pasted code is `<base64url>#<state>` — opaque, no shell interpolation.
  **Type the code, THEN send Enter (`\r`) as a SEPARATE write** (~300 ms later).
  A single `code\r` write is swallowed by the CLI's masked code prompt as a
  paste — the trailing `\r` never submits, so the code sits typed-but-unsent and
  no token is ever produced (this is the "that code did not work" bug: input was
  received — shown as `****…` — but never exchanged). With Enter sent
  separately the CLI exchanges the code and prints `sk-ant-oat01-…`, or, for a
  bad/expired code, `OAuth error: Request failed with status code 400 — Press
  Enter to retry.` (process stays alive → treat as bad code). Spawn with wide
  `cols` (512) so neither the URL nor the token wraps.
- **Token storage:** `DATA_DIR/secrets.json` (mode 0600, atomic write),
  `{ claudeOauthToken, connectedAt }`. The adapter injects
  `CLAUDE_CODE_OAUTH_TOKEN` from it per-turn; precedence is secrets.json > the
  legacy env var. **Never log/return the token** — redact `sk-ant-oat01-\S+` on
  every error/log path (`redactToken`), and `GET /api/admin/claude/status` never
  returns it, not even masked.

## Approval round-trip — `control_request`/`control_response` (verified 2026-07-03)

Verified live on **Claude Code 2.1.200** (macOS, Node 26): the native stdio approval path
**works** — the GH #34046 regression does NOT reproduce on this version. No MCP fallback needed.

Spawn shape (PER_TURN, stdin kept open):

```
claude -p --session-id <uuid> \
  --output-format stream-json --input-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --permission-mode acceptEdits --disallowedTools Bash --allowedTools WebSearch WebFetch
```

- User message goes in as ONE NDJSON line:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` —
  then **keep stdin open** (control responses must be writable). Close stdin after `result`;
  the process then exits 0.
- **`--resume` + `--input-format stream-json` works** (previously unverified): same
  `session_id` in init/result, prior-turn content recalled. Continuity confirmed.
- **Partial `stream_event` deltas still arrive** with `--input-format stream-json`
  (text_delta counted on a live turn) — streaming UX unaffected.

### Mid-turn steering (verified 2026-07-21)

Adding `--replay-user-messages` lets the adapter durably acknowledge mid-turn
input: write another ordinary `type: "user"` line while the process is working,
then wait for the CLI to echo that same user message on stdout before deleting
the server-side queue fallback. Verified live against Claude Code 2.1.200 by
injecting guidance during a five-second Bash tool call; Claude changed its final
answer to follow the injected message. OpenRouter uses this same Claude Code
transport, so it inherits the behavior.

If the replay does not arrive, the process ends, or the write fails, Veneer
retains the durable queued message and runs it as the next turn instead. This
avoids both the old wait-until-finished behavior in the normal case and the
pre-queue message-loss race on failures.

### Wire shapes (exact, observed)

`control_request` arrives on stdout when a gated tool is attempted. **`request_id` is
top-level** (not inside `request`), and the field is **`input`** (spec §7.2 guessed
`tool_input` — wrong):

```json
{"type":"control_request","request_id":"1093cc4f-53f7-407a-82d5-531401ae056a",
 "request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
   "input":{"file_path":"/…/probe-approval.txt","content":"allow-path-works"},
   "description":"probe-approval.txt",
   "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
   "tool_use_id":"toolu_01BJXbNr6H2zhEz9fJu5vjUd"}}
```

Response goes on stdin, wrapped twice (`response.response`):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same id>",
  "response":{"behavior":"allow","updatedInput":{...echo the request input...}}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<same id>",
  "response":{"behavior":"deny","message":"Denied by probe (testing the deny path)."}}}
```

- **Allow**: honored — the tool ran, file created, turn completed normally.
- **Deny**: honored — the tool does NOT run; the deny `message` echoes back on the stream as a
  `user` row `tool_result` with `is_error: true`, Claude adapts gracefully ("the write was
  denied… nothing further to do"), and `result` carries a `permission_denials` array
  (`[{tool_name, tool_use_id, tool_input}]`). Exit 0 either way.
- `permission_suggestions` (e.g. `setMode acceptEdits`) could power an "always allow" button
  later; ignored for now.
- Timeout strategy: there is no CLI-side deadline observed — the process waits indefinitely
  for the control_response, so the server owns the clock (10-min auto-deny per spec).
- Note: with `--permission-mode acceptEdits`, Write/Edit **inside the cwd** never prompts;
  writes outside the cwd do — handy for forcing a real approval in tests.

## Toolbox materialization + approvals (verified 2026-07-04, M3)

Verified live (macOS, logged-in `claude`, notes MCP fixture): the per-spawn toolbox
flags coexist with the phase-2 stdio approval path. Spawn shape now adds, on top of the
approval flags above:

```
  --mcp-config <per-spawn mcp-config.json> --strict-mcp-config \
  --settings <per-spawn settings.json>
```

- `settings.json` = `{ "permissions": { "allow": [...], "deny": [...] } }`. This REPLACES the
  old `--allowedTools WebSearch WebFetch --disallowedTools Bash` args (those built-ins now come
  from the built-in-tools policy row → the settings file). Confirmed: `deny` blocks a tool
  outright, `allow` pre-approves it (no card), and anything NOT in either list still fires a
  `control_request` under `--permission-mode acceptEdits` — MCP tool calls are not edits, so an
  `approve`/default-approve MCP tool prompts as expected.
- `--strict-mcp-config` isolates the spawn from the running user's `~/.claude` MCP servers; the
  per-spawn `mcp-config.json` (`{ "mcpServers": { "<slug>": {…} } }`) is the only MCP source.
- Policy edits apply on the NEXT turn with no restart: the manager re-materializes both files
  before every spawn. Verified by PATCHing a connection's policy between turns (approve → deny →
  allow) and observing each turn honor the new policy.

## Codex app-server permissions (0.144.4)

- Regenerated the local app-server TypeScript schema on 2026-07-23. Generic
  sandbox/network escalation is a server request named
  `item/permissions/requestApproval`.
- Its params include the exact requested `{ network, fileSystem }` additions.
  Its response is `{ permissions: GrantedPermissionProfile, scope }`; it does
  **not** use command/file approval's `{ decision }` response.
- Veneer grants only the requested additions for the current turn. Denial,
  expiry, and interruption return an empty turn-scoped grant.
- Server requests with an id that the adapter does not recognize receive an
  explicit JSON-RPC method-not-supported error, preventing protocol drift from
  leaving a turn waiting forever.
- The fake app-server regression fixture covers allow, deny/expiry, interrupt,
  and an unknown future request. A normal sandbox live NetSuite smoke probe is
  required after deployment.

## Codex app-server compatibility (0.153.4)

- Regenerated the experimental JSON schema on 2026-09-04 against 0.153.3 and
  compared it with the previously pinned 0.149.1 schema; 0.153.4 is a patch
  bump on the same day and its live `model/list` shape matched. Every request, notification, and
  approval method used by Veneer remains present.
- The only approval change relevant to the current adapter is an additive
  `kind` field on `item/commandExecution/requestApproval`; the existing
  command-approval response remains compatible.
- A live authenticated `model/list` returned `gpt-6-astra` as the default model
  with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` effort choices.

## Not verified here (deferred, per spec §16)

- LONG_LIVED strategy (multiple user messages over one process's stdin).
- AskUserQuestion behavior headless.
