# Adopting a Veneer Core project into Pro

Veneer Core (the tmux instance on `localhost:3210`) and Pro run under the same
`HOME`, so they share `~/.claude`. A Claude chat's history belongs to neither
app: it is a JSONL file the CLI writes at

```text
~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<sessionId>.jsonl
```

Core stores a pointer to it in its agent record; Pro stores one in
`conversations.native_session_id`. When both sides name the same working
directory, they name the same file. So migrating a project is not a data move —
it is a handful of row inserts.

```bash
# Plan it (default; writes nothing)
node scripts/migrate-core-project.mjs --core-project crew-seating

# Do it
node scripts/migrate-core-project.mjs --core-project crew-seating --apply

# Then, and only when no turn is in flight:
sqlite3 -readonly "$DATA_DIR/veneer-pro.db" "select count(*) from pending_turns where status='pending'"
node scripts/restart.mjs veneer-pro-runner
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--core-project` | *required* | Core project id (`crew-seating`) |
| `--agents` | `all-named` | `all-named`, or a comma list of agent ids |
| `--assistant` | `developer` | Pro persona the adopted chats run as |
| `--base` | `http://localhost:3210` | Core's API |
| `--apply` | off | Write. Without it, nothing is written. |

## What it writes

1. `projects` — one row, `root_dir` set to Core's project path. Matched on
   `root_dir`, not slug, so re-adopting a folder never forks the project.
2. `assistants` — the `developer` persona, if it does not exist yet (below).
3. `conversations` — one per adopted chat: `title` from the Core agent name with
   `title_auto = 0`, provider/model/effort copied from Core, `native_session_id`,
   and `created_at` / `last_active_at` read out of the transcript itself.
4. `settings` — a `turn_ran:<conversationId>` marker per chat.
5. `<root_dir>/.git/info/exclude` — `/CLAUDE.md` and `/AGENTS.md`.

Nothing under `~/.claude` is read for content, moved, copied, or renamed, and
Core is never called with anything but `GET`.

The last three are less obvious than they look:

- **`turn_ran`** is what `conversationManager.isFirstTurn` reads. Without it an
  adopted chat looks brand new, so its next turn spawns with
  `--session-id <an id the CLI already knows>` instead of `--resume`, and the
  CLI rejects that outright ("Session ID is already in use"). Adoption means the
  session has demonstrably already run.
- **`last_user_activity_at`** is stamped to now, not to the session's age.
  Auto-archive (`GET /api/conversations` runs it, at most once a minute) sweeps
  anything idle past the user's threshold — 5 days here — so dating an adopted
  chat honestly would archive all of them on the first list render. The
  displayed `last_active_at` still carries the real session times.
- **The git excludes** matter because the materializer renders `CLAUDE.md` and
  `AGENTS.md` into the turn's cwd before *every* turn, and for a project chat
  that cwd is the user's own checkout. `buildAgentRuntime` already does this for
  `VP_SOURCE_DIR`; an adopted repo needs it more, since `.git/info/exclude` is
  local and never pushed but a `git add -A` in a mirror-synced repo is not.

## Which chats

`--agents all-named` adopts the agents whose `autoNaming` is off. Core turns
that flag off when a human names a chat, which is the only durable line between
"a chat worth keeping" and the historical/subagent sessions sharing the same
transcript directory — crew-seating had 7 of the former and 131 of the latter.
The rest stay on disk, un-adopted, exactly where Core left them.

A chat is skipped, loudly, when its session file is not under the project's
transcript key, when a Pro conversation already points at that session id
(so a re-run is a no-op), or when it is not a Claude agent.

**Codex agents cannot be adopted.** Pro renders Codex history from its own
shadow transcripts under `DATA_DIR/codex-app-server-transcripts`, which a Core
agent has never written; the thread might resume, but it would resume with no
visible history. Claude only, for now.

## The `developer` persona

The adopted chats ran in Core's "full" mode — a real shell in the checkout — and
Pro grants that through an assistant with `full_access = 1`
(`--dangerously-skip-permissions`). None of the shipped personas fit:

| Persona | Why not |
| --- | --- |
| `assistant` | No shell, by design |
| `app-creator`, `data-analyst` | Scoped to other work |
| `platform-dev` | `createWorkspaceResolver` pins it to `VP_SOURCE_DIR` and ignores `project_id`, so an adopted chat would run in the Veneer checkout — and lose its transcript |

So the script creates a plain `Developer`: full access, and instructions that
say to read before writing, verify its own work, and not to commit or push
anything unasked. Full access here is parity with what these sessions already
had under Core, not an escalation — but it is real, and it applies to every
chat filed under that persona.

## Single ownership

Adoption is not a hand-off. Afterwards the same session file is reachable from
both apps, and Core still lists the same agents with the same session ids. That
is fine while only one side is used at a time; resuming the same chat from Core
and Pro simultaneously means two CLI processes appending to one JSONL. Retire
the Core agents when the project has actually moved.

## Cache caveat

`createWorkspaceResolver` caches project root directories for the life of the
runner process. A project row inserted under a warm runner resolves to nothing
until it restarts — the chats appear in the list, but their history does not
render. Restart the runner only, and only when `pending_turns` holds no
`pending` row: the drain re-enqueues an interrupted turn, but somebody is
waiting on it.
