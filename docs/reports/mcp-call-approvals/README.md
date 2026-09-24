# Codex MCP approval integration

BUILD315 bridges Codex's tagged one-call MCP approval form into Veneer's existing audited Ask/Auto approval lifecycle. It does not change Full Access, the sandbox, provider reviewer configuration, connector permissions, business approvals or huddle membership.

## Diagnosis and evidence limits

The configured runtime executable reports **Codex 0.156.1**; the shell's default executable reports 0.145.0 and was not used as the runtime contract. Offline `app-server generate-ts` for the configured binary exposes `mcpServer/elicitation/request` with `action`, `content` and `_meta` responses. The adapter previously returned -32601 for this method. A bounded exact-string scan found 14 unsupported-request log entries; no protected huddle content or raw provider request was read.

The [versioned OpenAI implementation](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/mcp_tool_call.rs) generates an empty object form tagged `codex_approval_kind=mcp_tool_call`. An accept response with null content and null metadata permits one call; persistence metadata can instead change session/policy behavior and is deliberately never returned by this bridge.

Anna's retained reports establish native Auto/full_access=0 and generic rejection text without a recorded native approval. They do not contain a correlated request/reviewer decision sufficient to prove the cause of her individual rejection. The missing protocol bridge is reproduced offline and repaired; Anna's live acceptance remains untested. An explicit provider or backend denial is still a denial and is never retried automatically.

## Supported boundary

- Only the exact tagged empty form, bound to the current native thread and turn, enters native approvals. Ask waits for the human; Auto uses the existing current-mode audit path.
- Allow returns `action=accept`, deny/expiry returns `decline`, Stop returns `cancel`; content and metadata are always null. No persistent permission amendment is created.
- Missing/stale/foreign turn or thread requests cannot create approvals. Resolved requests and duplicate answers cannot grant again.
- Generic data-entry, URL authorization, unknown or malformed forms fail closed with an unsupported-flow notice. No raw tool parameters or connector metadata are copied into the approval audit; the bounded provider prompt and server name identify the request.
- A successful approval is distinct from a successful tool result. A later backend denial is preserved without replay.
- Fresh and resumed conversations use the same bridge. Existing native ACL and current authority checks remain in the tools themselves.

## Validation and deployment

Root typecheck, full npm test and production build passed before deployment: 2,478 server tests (5 existing skips), 893 web tests, 40 browser-manager tests and 21 installer tests. Vite retained its existing large-chunk warning. The guide contract tests verify restricted employee access, dated discovery and current instructions for resumed agents. Regression fixtures cover Ask/Auto audit, explicit deny, Stop, fresh/resumed turns, malformed/unsupported/foreign/stale requests, completion without resolution, duplicate answers and tool success/backend failure. Deployment health receipt follows after restart. All tests use a local fake app-server and disposable databases; no Anna tool, business action, credential, provider call or membership mutation was used as a test.

## Changed files

- [adapter.ts](/Users/archerclawdington/veneer-os/server/src/providers/codexAppServer/adapter.ts)
- [catalog.ts](/Users/archerclawdington/veneer-os/server/src/featureGuide/catalog.ts)
- [codexAppServer.test.ts](/Users/archerclawdington/veneer-os/server/test/codexAppServer.test.ts)
- [approvalManager.test.ts](/Users/archerclawdington/veneer-os/server/test/approvalManager.test.ts)
- [fake-app-server.mjs](/Users/archerclawdington/veneer-os/server/test/fixtures/fake-app-server.mjs)

Employee and agent guidance: `/#/bot-guide?feature=mcp-call-approvals`. The shared catalog serves full and restricted employees and is included in resumed-agent instructions.
