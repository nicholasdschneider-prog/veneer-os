# Veneer Pro — v1 Build Spec

> **Update 2026-08-07 — Agent instruction context:** Veneer no longer renders or patches repository `CLAUDE.md` or `AGENTS.md` files. Those files are user-owned and provider-native. Veneer now supplies a short versioned Core rules block plus one fixed agent/project snapshot per chat through the provider instruction channel. Memory is turn-scoped reference data, connector truth comes from available tools, and page/app appearance is loaded only through the relevant project-settings workflow. The chat context receipt shows each source and role. This update supersedes older materialization notes below.

> **Update 2026-07-03 (evening):** the prototype (M1-lite) is SHIPPED, plus the in-app Claude account Connect/Logout feature (setup-token flow productized; token in `DATA_DIR/secrets.json`). New frontend decision: adopt **shadcn/ui with the June-2026 chat components** (MessageScroller, Message, Bubble, Attachment, Marker) as the component system for §14.
>
> **Update 2026-07-03 (night):** shadcn/ui migration SHIPPED to prod (radix flavor, nova preset). Chat runs on MessageScroller (anchored turns, autoscroll, jump-to-bottom, thread restore — bespoke stick-to-bottom code deleted); Message/Bubble rows; Marker + `shimmer` for tool/status/error rows; ChatList/Setup/Settings on button/input/card/dialog. Cream/ink palette is mapped into the shadcn semantic tokens in `web/src/styles.css` (`:root` + `prefers-color-scheme` dark — no `.dark` class); serif assistant prose and the memoized `{__html}` Markdown pattern preserved. Note: the operator logged out the Claude account in-app at 23:21 UTC — prod is awaiting a re-connect via Settings.
>
> **Update 2026-07-04:** approvals (workstream B, the `control_request` round trip) implemented and verified locally — awaiting deploy. **M0 gate result: the native stdio approval path WORKS on CLI 2.1.200** (GH #34046 does not reproduce; exact wire shapes in `docs/protocol-notes.md` — `request_id` is top-level, field is `input` not `tool_input`, responses are double-wrapped). The `approvalMcp.ts` fallback (§7.2) was NOT needed and is not built. Adapter stays PER_TURN but now spawns with `--input-format stream-json --permission-prompt-tool stdio`, stdin held open through the turn (`--resume` + stream-json input verified, partial deltas unaffected). Shipped per §5/§6/§9: `approvals` table (0002), `approval_requested`/`approval_resolved` events (extended with `approvalId`/`displayName`/`inputPreview` + outcome `expired`), derived `needs_you` status, `GET /api/approvals` + `POST /api/approvals/:id/resolve` (conversation owner or owner/consultant), 10-min auto-deny (`VP_APPROVAL_TIMEOUT_MS`; turn timer pauses while an approval is pending; stale pending rows expire at boot), inline approval card (Bubble/Marker + Approve/Deny) and `needs_you` badge on the chat list. Default policy unchanged: `acceptEdits`, Bash disallowed, WebSearch/WebFetch allowed — writes outside the workspace cwd are the natural approval trigger. Known v1 limit: approval cards live in the turn buffer only; after the turn ends, rehydrated transcripts show the denial as a failed tool result instead of the card (DB keeps the audit row).

> **Update 2026-07-04 (Phase 4 · workstream 0 — Restart button):** SHIPPED to prod. `POST /api/admin/restart` (owner/consultant only) responds `202` then exits cleanly — `manager.shutdown()` kills any in-flight turn child, the Claude login-flow child + DB are closed, `process.exit(0)`. Droplet unit `veneer-pro.service` changed `Restart=on-failure` → `Restart=always` + `RestartSec=1` (the allowed service-config change; DB/secrets untouched) so a clean exit respawns — verified on the droplet (SIGTERM → clean exit → systemd respawn, new PID). UI: a subtle floating `⟳` button bottom-right on every screen **except Chat** (composer/safe-area), admin-only; tap → confirm dialog → "Restarting…" overlay that polls `/api/me` and reloads once the server answers. Pending approvals survive (DB rows; boot-time expiry handles stale ones). Verified locally 390×844 light+dark (button, dialog, restart round-trip, auto-reconnect) and in prod (service healthy, tunnel 302). Commit `feat(admin): floating restart button` on `main`.
>
> **Update 2026-07-04 (M3 — Toolbox):** MCP connections + per-connection policy + materialization + test probe SHIPPED (workstreams A+B). Migration `0003_connections.sql` (additive) adds the `connections` table per §5. `toolbox/policy.ts` = zod-validated policy JSON (`default` + ordered glob `rules`, first-match-wins) with a global built-in-tools policy row in `settings` (`builtin_tools_policy`; defaults reproduce the shipped behavior: Bash→deny, WebSearch/WebFetch→allow, else acceptEdits+approve). `toolbox/materialize.ts` runs on **every spawn** (no restarts): writes a per-spawn `mcp-config.json` (enabled MCP connections) + `settings.json` (`permissions.allow`/`.deny` from built-in policy + each connection's policy, a non-approve `default` scoped to `mcp__<slug>__*`), and renders `CLAUDE.md`+`AGENTS.md`. The adapter now spawns with `--mcp-config <file> --strict-mcp-config --settings <file>` (the hardcoded `--allowedTools`/`--disallowedTools` moved into the settings file); `approve`/default-approve tools fall through to the phase-2 `control_request` path unchanged. Secret hygiene: MCP env/headers are treated like `secrets.json` — never logged, masked in API responses (`hasSecrets` + blanked values), write-only updates (blank = keep). Routes `GET/POST /api/connections`, `PATCH/DELETE /api/connections/:id`, `POST /api/connections/:id/test` (real MCP `initialize`+`tools/list` probe, no Claude turn/auth needed) with authz: members never, consultant always, owner only `managed_by='owner'`. The Settings UI provides MCP add/edit with secret fields and a plain-language policy editor. **M3 acceptance met locally** (dev-identity e2e): real MCP connection added via API → test probe lists tools → default `approve` raised an approval card → approve ran the tool; a `deny` rule blocked it with no card; an `allow` rule ran it with no card; all applied on the next turn with no restart.

**Status:** approved for build · **Date:** 2026-07-03
**Product name:** Veneer OS
**Repo:** this repository, with fresh history — not a fork of any earlier Veneer codebase

Decisions locked (2026-07-03): build separately from Outpost, migrate clients later · one chat UI (assistants modeled in schema, hidden in v1 UI) · real multi-user isolation from day one · connections mostly consultant-managed · email in+out first-class via agentic-inbox · **Linux-first** · **Claude + Codex from day one** (Copilot/Gemini CLI possible later) · **TypeScript**.

---

## 1. Product summary

A self-hosted web app for non-technical small-business owners: chat with AI assistants that run on the business's own box (VPS or physical), powered by the client's own Claude Code / Codex subscriptions. No git, no terminal, no CLI concepts anywhere in the UI. The operator ("consultant" role) remotely manages each client's MCP connections and policies through the app — never SSH.

**Goals (v1):**
- Chat with streaming responses, rendered chat-quality (port Veneer's Pretty View standard).
- Human-in-the-loop approvals for risky actions (send email, write to NetSuite), delivered in chat + notification.
- Multi-user with real isolation (owner / member / consultant roles).
- Toolbox UI: MCP connections + per-connection policy, remote-administrable.
- Email as a channel both directions (agentic-inbox in, Resend out, proper threading).
- Automations: scheduled prompts whose results deliver by email or chat.
- One-command install on macOS.

**Non-goals (v1):** git UI, terminals, dev-services, file browser as a primary surface, mutagen/remote-pair, canvas project layout, workflow tree, usage/stats dashboards, Ollama/local models, native Mac integration.

---

## 2. System overview

```
                     Cloudflare Tunnel + Access (identity)
  Browser (PWA) ────────────────┐
  Email (agentic-inbox worker) ─┤ webhook
                                ▼
                     ┌─────────────────────────────┐
                     │  veneer-pro server (Node/TS) │  loopback :3100
                     │                              │
   REST + WS  ◄──────┤  channels/   web, email      │
                     │  runtime/    conversation mgr │
                     │  providers/  claude, codex    │──── spawns ────► claude CLI (stream-json)
                     │  toolbox/    connections etc. │                  codex app-server (JSON-RPC)
                     │  automations/ scheduler       │
                     │  identity/   CF Access        │        session truth on disk:
                     │  db/         SQLite           │        ~/.claude/projects/**/<sid>.jsonl
                     └─────────────────────────────┘        ~/.codex/sessions/**
```

Core principle: **the DB is an index, never a copy.** Transcript truth lives in the providers' native session files; the server parses them into one normalized event model. Live streaming comes from the running process's stdout; rehydration comes from the session file. Status is **derived** (process alive / pending control request / idle) — no hook sockets, no status state machine, no pollers.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS, ESM, TypeScript 5 strict | |
| HTTP | Express 4 + `ws` | boring on purpose; same as Veneer |
| DB | better-sqlite3, WAL, migrations dir (numbered .sql, runner ported from Veneer `services/db.js` concept) | |
| Validation | zod on every route body + every provider wire message | |
| Frontend | Vite + React 19 + Tailwind 4, PWA (manifest + SW + web-push later) | |
| Tests | vitest + testing-library; provider adapters get golden-file wire tests | |
| Process mgmt | systemd (`systemctl --user`), no pm2 | |
| Ingress | cloudflared tunnel → `localhost:3100`; Cloudflare Access for identity | |
| Secrets | env file `~/.config/veneer-pro/env` (0600), loaded by systemd unit | |

Conventions: no god components (hard cap ~400 lines/file enforced in review); server state flows through one `AppContext` object (db, config, runtime, channels) — no module-level singletons except the db handle.

---

## 4. Repo layout

```
veneer-pro/
  package.json            # workspaces: server, web
  server/
    src/
      index.ts            # bootstrap: db migrate, http, ws, channels, scheduler, runtime recovery
      context.ts          # AppContext wiring
      config.ts           # zod-validated config (file + env)
      identity/
        cloudflareAccess.ts   # port of Outpost middleware: JWT verify vs team JWKS, req.user
        authorize.ts          # role/isolation checks (one choke point)
      db/
        db.ts, migrate.ts
        migrations/0001_init.sql ...
      runtime/
        conversationManager.ts  # spawn/attach/reap/interrupt; one entry per live conversation
        processStrategy.ts      # LONG_LIVED vs PER_TURN (see §7.1) behind one interface
        events.ts               # ConversationEvent types + zod schemas
        statusOf.ts             # derived status
      providers/
        types.ts            # Provider interface
        claude/
          adapter.ts        # spawn args, stdin writer, stdout parser
          wire.ts           # zod schemas for stream-json messages incl. control_request/response
          transcript.ts     # JSONL session-file parser → ConversationEvent[] (port from Veneer)
          approvalMcp.ts    # FALLBACK: local stdio MCP server for --permission-prompt-tool
        codex/
          adapter.ts        # app-server JSON-RPC client (stdio)
          wire.ts           # generated via `codex app-server generate-ts`, wrapped in zod
          transcript.ts     # ~/.codex/sessions parser (port from Veneer)
      channels/
        webSocket.ts        # /ws frames: snapshot + event push (pattern from Veneer transcriptSocket)
        email/
          inbound.ts        # agentic-inbox webhook receiver (HMAC verified)
          outbound.ts       # Resend send with threading headers
          threading.ts      # email_links resolution
      toolbox/
        connections.ts      # CRUD + policy storage
        materialize.ts      # toolbox state → per-spawn provider config (see §11.3)
        policy.ts           # decideAction(toolName, input, policies) → allow|approve|deny
      automations/
        scheduler.ts        # cron tick (cron-parser), spawns headless runs, delivery
      documents/
        outbox.ts           # File Box successor: publish + list + serve
      routes/               # thin: zod-parse → service call → json. One file per resource.
      notify/
        push.ts             # web-push (M4), email fallback for approvals
  web/
    src/
      app/                  # routes: /chat/:id, /approvals, /automations, /documents, /admin/*
      components/chat/      # transcript renderer, cards (approval, question), composer
      components/admin/     # toolbox, users, assistant instructions
      lib/api.ts, lib/ws.ts
  installer/
    install-darwin.mjs      # idempotent macOS provisioner (see §14)
    document-tool provisioners
    cloudflared setup notes
  cli/
    vp.ts                   # box-side helper: `vp doctor`, `vp file <path>` (File Box publish), `vp update`
  docs/
    protocol-notes.md       # M0 findings: exact verified wire shapes per CLI version
```

---

## 5. Domain model & schema

Roles: `owner` (sees everything on the box), `member` (sees only their own conversations/automations), `consultant` (everything + toolbox/admin).

```sql
-- 0001_init.sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,          -- matched against CF Access identity + inbound email sender
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member','consultant')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistants (               -- v1 seeds exactly one; UI hides the concept
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,           -- workspace dir name
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',  -- rendered into workspace CLAUDE.md / AGENTS.md
  default_provider TEXT NOT NULL DEFAULT 'claude' CHECK (default_provider IN ('claude','codex')),
  default_model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,                 -- uuid, minted by server
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),      -- owner of the conversation (isolation key)
  title TEXT,                          -- auto-named from first exchange (port Veneer auto-name)
  provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
  model TEXT,
  native_session_id TEXT NOT NULL,     -- claude session uuid / codex thread id (minted up front)
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','email','automation')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,            -- provider control request id
  tool_name TEXT NOT NULL,
  request_json TEXT NOT NULL,          -- full tool input for display
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';

CREATE TABLE connections (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','skill')),
  name TEXT NOT NULL,                  -- user-facing: "Shopify", "NetSuite lookups"
  slug TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,           -- mcp: {transport, command|url, env|headers}; skill: {dir}
  policy_json TEXT NOT NULL DEFAULT '{"default":"approve"}',   -- see §11.2
  enabled INTEGER NOT NULL DEFAULT 1,
  managed_by TEXT NOT NULL DEFAULT 'consultant' CHECK (managed_by IN ('consultant','owner')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE automations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,              -- cron expr or 'once:<iso>'
  prompt TEXT NOT NULL,
  deliver_via TEXT NOT NULL DEFAULT 'email' CHECK (deliver_via IN ('email','chat')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','delivered','failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT
);

CREATE TABLE documents (               -- File Box successor
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                  -- absolute, inside data dir documents/
  label TEXT NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE email_links (
  message_id TEXT PRIMARY KEY,         -- RFC 5322 Message-ID (ours + theirs)
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value_json TEXT NOT NULL );
```

**Isolation rule (single choke point, `identity/authorize.ts`):** every conversation/automation/document query is filtered by `user_id = me` unless role ∈ {owner, consultant}. Approvals are visible to the conversation owner + owner + consultant; only those may resolve. Toolbox writes: consultant always; owner only where `managed_by='owner'`.

---

## 6. Normalized event model

All providers map into this; UI/email/automations consume only this. (`server/src/runtime/events.ts`)

```ts
type ConversationEvent =
  | { type: 'turn_started'; turnId: string; role: 'user'; text: string; at: string; via: Channel }
  | { type: 'text_delta';   turnId: string; text: string }                       // live only, not persisted
  | { type: 'text_final';   turnId: string; markdown: string; at: string }
  | { type: 'thinking';     turnId: string; summary?: string }
  | { type: 'tool_started'; turnId: string; toolId: string; toolName: string; displayName: string; inputPreview: string }
  | { type: 'tool_finished';turnId: string; toolId: string; ok: boolean; resultPreview?: string; imageRef?: string }
  | { type: 'approval_requested'; requestId: string; toolName: string; input: unknown; policyReason: string }
  | { type: 'approval_resolved';  requestId: string; outcome: 'approved'|'denied'; byUserId: number }
  | { type: 'question_asked';   requestId: string; question: string; options: {label: string; value: string}[]; multi: boolean }
  | { type: 'question_answered';requestId: string; answer: string }
  | { type: 'files_produced';   documentIds: number[] }
  | { type: 'turn_done';  turnId: string; usage?: { inputTokens: number; outputTokens: number; contextPct?: number } }
  | { type: 'error';      message: string; fatal: boolean };
```

Rendering rules (port Veneer Pretty View standards): markdown via `marked` + DOMPurify, memoized `{__html}` objects (React 19 identity gotcha — see memory `react19-dangerouslysetinnerhtml-reapply`), tool activity collapsed to friendly one-liners ("Searching your Shopify orders…") using a toolName→displayName map from the toolbox, inline images by reference, approval/question cards tappable.

---

## 7. Provider adapters

```ts
// server/src/providers/types.ts
interface ProviderAdapter {
  id: 'claude' | 'codex';
  mintSessionId(): string;
  spawn(conv: ConversationSpawnSpec): ProviderHandle;   // resumes native session if it exists
  send(h: ProviderHandle, message: UserMessage): void;
  respond(h: ProviderHandle, requestId: string, answer: ApprovalAnswer | QuestionAnswer): void;
  interrupt(h: ProviderHandle): void;
  onEvent(h: ProviderHandle, cb: (e: ConversationEvent) => void): void;
  readTranscript(conv: ConversationRef): Promise<ConversationEvent[]>;  // parse session file
  authStatus(): Promise<{ loggedIn: boolean; detail: string }>;
}

interface ConversationSpawnSpec {
  cwd: string;                    // assistant workspace dir
  nativeSessionId: string;
  model?: string;
  systemAppend: string;           // assistant instructions + Veneer Pro conventions
  mcpConfig: McpConfigFile;       // materialized from toolbox (see §11.3)
  settings: ProviderSettings;     // materialized permission pre-allowlist
  env: Record<string, string>;    // VP_CONVERSATION_ID, VP_DOCUMENTS_DIR, ...
}
```

### 7.1 Process strategy (both must be implemented; M0 picks the default)

- **`LONG_LIVED`** (preferred): one process per active conversation. Claude: `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages [--resume <sid>]`; messages written to stdin as NDJSON; idle-reaped after 10 min (configurable); next message respawns with `--resume`. Codex: `codex app-server` is inherently long-lived (one shared process, thread per conversation).
- **`PER_TURN`** (verified fallback for Claude): spawn `claude -p --resume <sid> --output-format stream-json --verbose --include-partial-messages "<msg>"` per user message; process exits at turn end. Costs a few seconds startup per turn; zero supervision complexity. If M0 finds `--resume` + `--input-format stream-json` broken, ship PER_TURN and revisit.

Both live behind `processStrategy.ts`; the conversation manager doesn't know which is active.

### 7.2 Claude wire protocol (verified facts + M0 checks)

- NDJSON both directions, flush per line. User message in: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`.
- Out: `system` (init: session_id, tools, mcp_servers — check per-server status here and surface toolbox failures), `assistant`, `stream_event` partials (with `--include-partial-messages`), `result` (usage), and **`control_request`**:
  - `{"type":"control_request","request":{"subtype":"can_use_tool","request_id":"...","tool_name":"Bash","tool_input":{...}}}`
  - respond: `{"type":"control_response","response":{"subtype":"success","request_id":"...","behavior":"allow"|"deny","message":"..."}}`
- Approval routing requires `--permission-prompt-tool stdio`.
- ⚠️ **Known risk:** GH issue #34046 reports `can_use_tool` control requests not emitted on CLI 2.1.73–2.1.74. **M0 must verify on our CLI version.** Designed fallback: `providers/claude/approvalMcp.ts` — a tiny local stdio MCP server exposing one `approve` tool, passed via `--permission-prompt-tool mcp__vpapproval__approve`; it forwards the request to our approvals API over loopback HTTP and blocks until resolved (MCP responses must wrap in `mcp_response` within the 60s window — send periodic progress or re-prompt on timeout; M0 measures the real timeout behavior).
- AskUserQuestion in headless mode: behavior unverified — M0 test. If it doesn't surface as a control request, disable the tool via settings and rely on plain-text questions (chat handles them naturally).
- Session files: `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` — parser ported from Veneer `services/claude-transcript.js` (rewrite in TS, keep the golden-file tests).

### 7.3 Codex adapter

- One `codex app-server` process (stdio JSON-RPC 2.0 lite). Threads = conversations: `thread/start`, `thread/resume`, `thread/fork`; `turn/start` sends user input; events stream as notifications; exec/patch approvals arrive as JSON-RPC requests we answer.
- **First implementation task:** run `codex app-server generate-json-schema` (and `generate-ts`) against the pinned codex version; commit generated types to `providers/codex/wire.ts` and record shapes in `docs/protocol-notes.md`. Pin the codex version in config; regenerate on upgrade.
- Session files: `~/.codex/sessions/**` — parser ported from Veneer `services/codex-transcript.js`.

### 7.4 Auth (both providers, headless Linux)

- **Claude:** `claude setup-token` (sanctioned headless path) → one-year `sk-ant-oat01-*` token → `CLAUDE_CODE_OAUTH_TOKEN` in the service env file. Draws from the client's Pro/Max plan. `vp doctor` checks expiry/liveness via `authStatus()`.
- **Codex:** `codex login --device-auth` per account (ChatGPT plan); credentials in `$CODEX_HOME/auth.json` (0600). Several accounts can be connected with one active, as for Claude: the first (adopted) account keeps Pro's `.codex` profile, every further one is its own `CODEX_HOME` under `.codex-accounts/<id>/` where everything but `auth.json` is a symlink into the primary profile, so thread history, skills and config are shared and a chat resumes on whichever account is active. Registry (labels, active id; no secrets) in `DATA_DIR/codex-accounts.json`; a sign-in runs in a staging home and is adopted on success, so adding an account never signs another out. A turn that fails on a usage limit switches to the account with the most headroom and continues (`providers/codex/accountFailover.ts`).
- Provisioning captures both; the admin UI shows login state per provider (red banner when broken).

---

## 8. Conversation runtime

`conversationManager.ts` holds `Map<conversationId, LiveConversation>`:

- **Message arrives** (web/email/automation): insert `turn_started`, get-or-spawn handle, `send()`. Serialized per conversation (one in-flight turn; queued messages concatenate).
- **Events stream** → fan out to: WS subscribers (live), approvals table (on `approval_requested`, + notify), documents (on `files_produced`), email channel (if conversation channel is email, `turn_done` triggers reply send), title auto-namer (first `turn_done`).
- **Status** (`statusOf.ts`): `working` (process alive, turn open) · `needs_you` (pending approval/question) · `idle` · `failed` (last turn errored). Nothing persisted; computed from live map + approvals table + last event.
- **Reaping:** idle LONG_LIVED processes killed after `idleReapMinutes` (default 10). Kill = SIGTERM, 5s, SIGKILL.
- **Reboot recovery:** none needed by design — no live processes are assumed at boot; conversations resume lazily on next message. Pending approvals older than `approvalExpiryHours` (default 24) expire with a chat notice.
- **Concurrency cap:** max N live provider processes (default 4, config) — VPS-sized; excess conversations queue spawn.

---

## 9. HTTP / WS API

All routes behind CF Access identity middleware; zod-validated; authz through `authorize.ts`.

```
GET    /api/me
GET    /api/conversations                      ?archived=  (scoped by role)
POST   /api/conversations                      {assistantId?, provider?, model?, firstMessage}
GET    /api/conversations/:id                  (meta + status)
GET    /api/conversations/:id/transcript       (normalized events; rehydrate)
POST   /api/conversations/:id/messages         {text, attachments?}
POST   /api/conversations/:id/interrupt
PATCH  /api/conversations/:id                  {title?, archived?}
DELETE /api/conversations/:id

GET    /api/approvals                          ?status=pending (scoped)
POST   /api/approvals/:id/resolve              {outcome: approved|denied, note?}
POST   /api/questions/:requestId/answer        {answer}

GET    /api/documents                          ?conversationId=
GET    /api/documents/:id/download

GET/POST/PATCH/DELETE /api/automations         (+ POST /api/automations/:id/run)
GET    /api/automations/:id/runs

-- consultant/owner admin --
GET/POST/PATCH/DELETE /api/admin/connections   (policy edits included; PATCH re-materializes)
POST   /api/admin/connections/:id/test         (spawn probe: does the MCP server init?)
GET/POST/PATCH/DELETE /api/admin/users
GET/PATCH /api/admin/assistants/:id            {name, instructions, defaultProvider, defaultModel}
GET    /api/admin/health                       (provider auth, disk, versions, tunnel)

POST   /api/channels/email/inbound             (HMAC-signed; agentic-inbox worker only)

WS     /ws                                     (one socket; client subscribes per conversation)
  → {kind:'subscribe', conversationId}
  ← {kind:'snapshot', conversationId, events: [...], status}
  ← {kind:'event', conversationId, event: ConversationEvent}
  ← {kind:'status', conversationId, status}
```

WS follows Veneer's proven pattern (snapshot on subscribe, deltas after, reconnect-with-backoff, wake-on-visibility) but **one multiplexed socket**, and no HTTP polling loops — status rides the socket.

---

## 10. Identity & authorization

- Port Outpost's `cloudflareAccessIdentity.js` to TS: verify `Cf-Access-Jwt-Assertion` (RS256 vs team JWKS, aud/iss/exp), identity = email → users row. Unknown email → 403 page telling them to contact the administrator (no self-signup).
- Server binds loopback only; the tunnel is the sole path in. WS upgrades re-run identity (Outpost lesson).
- Consultant access: an operator email may be seeded as `consultant`. The CF Access policy allows exactly the emails that should reach this install.
- No app-level passwords/sessions ever.

---

## 11. Toolbox

### 11.1 Concepts
- **Connection:** an MCP server (stdio command or remote HTTP+headers) with a friendly name, health status, and a policy.

### 11.2 Policy JSON (per connection)
```json
{ "default": "approve",
  "rules": [
    {"match": "mcp__shopify__get_*",  "action": "allow"},
    {"match": "mcp__shopify__*write*","action": "approve"},
    {"match": "mcp__gmail__send*",    "action": "approve"},
    {"match": "*",                    "action": "deny"} ] }
```
Actions: `allow` (pre-allowlisted), `approve` (runtime human approval), `deny`. First matching rule wins; `default` applies to the connection's tools otherwise. Built-in tools get a global policy row (e.g. Bash → `deny` for members' conversations by default, WebSearch/Read → allow).

### 11.3 Materialization (`toolbox/materialize.ts`)
On every spawn (so toolbox edits apply on next turn, no restarts):
- **Claude:** write per-spawn `mcp-config.json` (enabled MCP connections) → `--mcp-config <file> --strict-mcp-config`; write `--settings <file>` with `permissions.allow` = all `allow`-rule patterns and `permissions.deny` = deny patterns; everything else falls through to the approval callback (§7.2).
- **Codex:** render `mcp_servers` into a per-spawn `-c` config overrides / profile; approvals arrive natively via app-server requests and route through the same `policy.ts` decision.
- Assistant instructions render to `<workspace>/CLAUDE.md` and `<workspace>/AGENTS.md` (same content), plus standing conventions: "publish deliverables with `vp file`", "you may ask the user questions in plain text", tone guidance for non-technical users.

### 11.4 Consultant remote admin
The admin UI **is** the remote admin — a consultant opens `/admin` through CF Access. `connections/:id/test` gives a one-click probe so toolbox changes are verifiable without SSH.

---

## 12. Email channel

- **Address:** one per box. Config keys: `email.address`, `email.webhookSecret`, `email.resendFrom`.
- **Inbound:** agentic-inbox worker forwards parsed mail (from, message-id, in-reply-to, subject, text, attachments) → `POST /api/channels/email/inbound` (HMAC-SHA256 signature header; reject unsigned). Resolution: `In-Reply-To`/`References` ∈ `email_links` → append to that conversation; else sender email ∈ users → new conversation (`channel='email'`, title = subject); else forward-to-owner notice, no agent run.
- **Outbound:** on `turn_done` for email conversations, render final markdown → text + simple HTML, send via Resend with `In-Reply-To`/`References` set to the inbound Message-ID; record our Message-ID in `email_links`. Attachments: documents produced that turn attach when < 5 MB total, else links.
- **Approvals by email:** notification emails include approve/deny one-click links (signed, single-use, expiring tokens) — satisfies "feels like the agent can easily send and receive email from me."
- **Loop guard:** never auto-respond to auto-generated mail (check `Auto-Submitted`/`Precedence` headers); max N agent-initiated sends per hour per conversation (config, default 10).

---

## 13. Automations

- `scheduler.ts` ticks every 30s: due automations (cron-parser, box-local TZ) → create conversation (`channel='automation'`, owned by the automation's user) → run prompt → on `turn_done`, deliver: `email` → send result to user's email; `chat` → conversation appears in their list with an unread badge. Record `automation_runs`; failures notify the user + consultant.
- Automations run under the same toolbox policy — an automation needing an approval pauses as `needs_you` and notifies, it never self-approves.
- NL→cron helper endpoint reuses Veneer's `ai-cron` idea (small model call) so the UI can offer "every Monday at 8am" input.
- One-shot (`once:<iso>`) supported: "next week tell me how X went" = the assistant (or UI) creates a one-shot automation. Expose creation as an MCP tool (`mcp__veneerpro__schedule`) so agents can schedule follow-ups when asked in chat.

## 13.5 Documents

`vp file <path> [--label "..."]` (and an MCP tool equivalent) copies a deliverable into `<data>/documents/<conversationId>/`, inserts a row, emits `files_produced`. UI: Documents tab (scoped) + per-conversation chips. This replaces Veneer's session File Box with durable storage (survives session end; cleanup policy = keep forever v1).

---

## 14. Frontend spec

Screens (mobile-first PWA, port Veneer's iOS lessons — safe-area, standalone, theme-color bootstrap, update toast):

1. **Chat list** (home): conversations sorted by activity, status dots (working spinner / needs-you badge / unread), search, new-chat button. No projects, no canvas.
2. **Chat**: transcript (chat bubbles, friendly tool one-liners, approval + question cards inline, image/doc chips), composer (text, attach, voice later), interrupt button while working. Streaming via `text_delta`.
3. **Approvals** (bell): pending across conversations; tap → card with full detail → approve/deny.
4. **Automations**: plain-language list ("Weekly sales recap — Mondays 8am → email"), create/edit modal with NL schedule input, run history.
5. **Documents**: list + preview (pdf/csv/image/md) + download.
6. **Admin** (owner/consultant only, hidden otherwise): Toolbox (MCP connections + policies + test button), Users, Assistant (name/instructions/model), Health, Update.

State: TanStack Query for REST + a thin WS event bus that patches query caches; no polling. Component budget: transcript renderer is its own package-like module with golden-render vitest tests (Veneer's most valuable test pattern).

---

## 15. Installer & ops

Veneer OS installs on one macOS arm64 machine. See [`README.md`](../README.md)
for prerequisites, the env-key list, the install and update commands, and the
Cloudflare Access / cloudflared tunnel setup. `installer/install-darwin.mjs`
is idempotent: re-run it after every `git pull` + build.

The historical Linux VPS bootstrap, the numbered-release update channel, and
the Studio fleet dashboard were removed when Pro became a single install.

---

## 16. Milestones & acceptance criteria

**M0 — Protocol spike (throwaway code allowed, findings are the deliverable → `docs/protocol-notes.md`)**
On the DO VPS with real subscription auth:
1. Claude LONG_LIVED: multi-message conversation over stdin stream-json with `--resume`; partial deltas received. Record exact wire samples per event type.
2. **Approval round-trip** with `--permission-prompt-tool stdio` on current CLI: `control_request` received → `control_response` allow/deny honored. If the #34046 bug reproduces → implement and validate the `approvalMcp` fallback; measure the 60s MCP timeout behavior and document the keep-alive strategy.
3. AskUserQuestion behavior headless: surfaces as control request? If not → disable tool, note it.
4. PER_TURN fallback timed: spawn-to-first-token latency with `--resume` on the VPS.
5. Codex: `generate-json-schema` dump committed; one full turn + one exec-approval round-trip via app-server.
6. `setup-token` auth works for all of the above; kill -9 the server mid-turn and confirm session file integrity + resume.
✅ Exit: every "unverified" in this spec is verified or has its fallback chosen.

**M1 — Chat product (single user).** Runtime + Claude adapter + WS + chat list/chat screens + transcript parser + documents + auto-titles. ✅ Daily use for a week; transcript rendering matches the Pretty View quality bar.

**M2 — Multi-user + Codex + install.** CF Access identity, roles/isolation, Codex adapter GA, the installer end-to-end on a fresh machine in < 30 min. ✅ A member account cannot see owner conversations (tested); codex and claude conversations coexist.

**M3 — Toolbox.** MCP connections/policies UI + materialization + test probe + approvals wired to policy. ✅ The operator adds a real MCP connection (e.g. Shopify) remotely, sets write-actions to `approve`, and an approval card + resolution works end-to-end with zero SSH.

**M4 — Email + Automations.** Inbound/outbound with threading, approval emails with one-click links, scheduler + NL cron + `mcp__veneerpro__schedule`. ✅ Demo: "every Monday email me a summary of last week's orders" created in chat, fires, result lands in the owner's inbox, reply to that email continues the conversation.

---

## 17. Risks & open questions

| Risk | Mitigation |
|---|---|
| `control_request` bug (#34046) on current CLI | M0 gate; approvalMcp fallback designed in |
| stream-json input + `--resume` combo unverified | PER_TURN strategy is fully verified; strategy is pluggable |
| Claude Code wire format drifts across versions | pin CLI versions per box; zod-validate every message; golden wire tests; `vp doctor` flags version drift |
| Codex app-server protocol churn | generated types per pinned version; regenerate on upgrade |
| Subscription ToS posture | product wraps each client's own logged-in Claude Code/Codex, same posture as Veneer today; setup-token is the documented headless path |
| One Linux user runs all agents (no OS-level isolation between app users) | acceptable v1 (same as today); policies + deny-by-default Bash for members; revisit with per-user OS accounts if needed |
| Email loops / abuse | loop guards §12; approvals for outbound sends |

Open (non-blocking): client-domain email addresses; voice input port timing; web-push vs email-only notifications in M4.
