# Build #767 live check, 2026-10-13

Deployed in commit 0d440ef. The services restarted at 13:04:50Z, and runner pid 59947 has been up since 13:04:52Z.

## 3 concurrent Codex lanes (14:4xZ)

Run with `node out/build767/live-check.mjs <platform-dev mcp-config.json> 3`.

- **Setup:** the 9 remote servers (8 Composio plus Runway) with the deployed shaping: `mcpRemoteBridge.js`, `startup_timeout_sec=60` and `mcp_optional_startup_grace_ms=0`.
- **Result:** every lane's `GMAIL_GET_PROFILE` call on gmail-help returned help@elkhartrvparts.com, in 15–20 s.
  - Threads: 01a135bd-405e-7de1-b1c9-646f21b0dae9, -6458eea7e7b0 and -64404f6e30ff.
- **logs_2:** those threads have no "using cached MCP catalog without waiting for startup", no "omitting MCP server without an exact ready client" and no "omitting MCP tool …" lines.

## Production since the deploy (13:05–14:47Z)

- **Cached binding:** no Composio or Runway server was bound from the cached catalog. The only hits are codex_apps and node_repl, which are Codex-internal.
- **Successful calls:** real GET_PROFILE calls returned help@ in 7 Codex threads (6 in CS coordination lanes), and nick@ and accounting@ also worked. No "is not a function" or "not available to the model" errors.
- **Bridges:** 28 were running via mcpRemoteBridge.js and none via npx.
- **Remaining omissions:** these happen when a server's startup actually fails, and the server is then left out of that step's tools rather than shown without a client:
  - runway: 33 lines across 14 threads (loopback relay; this predates #767)
  - gmail-help: 6 lines across 3 threads
  - Codex keeps too little launcher stderr to show why.

## Independent read-only smoke pass (coordination thread d6001ff6, 2026-10-13)

- All three catalogs were present in one Codex session, and every call succeeded:
  - gmail-help `GMAIL_GET_PROFILE` returned help@elkhartrvparts.com (log_vNZ0KQP0h5A6).
  - ERVP Calendar `GET_CURRENT_USER` returned nick@elkhartrvparts.com (log_5rgnwTqhfBcn).
  - Runway `whoami` returned authenticated:true.
- Nothing was written or generated.
- This was a single session. It is not final acceptance, and it does not prove the intermittent startup omissions are gone. Acceptance still belongs to Miles.

## Clara 20:46Z "dedicated accounting connector missing" report

- **Chat and turn:** Clara chat 7f83ff8e, Codex thread 01a13647, turn 01a13703.
- **Diagnosis:** the connector was not missing. Clara's tool search simply failed to match the tool names.
  - The accounting connector (user_connectors id 3) is shared and scoped to Clara's project e8e0efc6.
  - logs_2 has no "omitting MCP server", "cached MCP catalog" or "not available to the model" line for this thread. It also has none from any process between 20:45:30Z and 20:52Z.
  - Clara never called a dedicated tool in that turn. The turn only filtered `ALL_TOOLS` with case-sensitive lowercase regexes: `/gmail.*profile/`, `/gmail_get_profile|gmail.*message|…/` and `/profile|…/`.
  - The dedicated tools have upper-case names, such as `mcp__gmail_accounting_elkhartrvpart_everyone_3__GMAIL_GET_PROFILE`, so none of those patterns could match them. Only the lowercase `mcp__codex_apps__gmail_*` tools matched, which produced "only generic Gmail".
  - Earlier the same day, the same thread called the dedicated tools by exact name and they worked, for example `GET_PROFILE` at 17:22Z and 17:56Z.
- **Repair:** none needed on the source side. On its next turn, Clara should call the exact tool name directly or search with `/i`.
- **Not yet proven:** this only becomes recovery once Clara's own `GET_PROFILE` call in chat 7f83ff8e succeeds.
