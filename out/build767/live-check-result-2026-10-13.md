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
