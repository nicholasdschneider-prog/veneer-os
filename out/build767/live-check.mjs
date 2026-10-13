// Build #767 live check: N concurrent Codex app-server threads started at the
// same moment with the deployed MCP shaping (pinned bridge, cache opt-out,
// startup wait). Each thread makes one read-only GMAIL_GET_PROFILE call on
// help@. Never prints header values; the filtered config lives in a 0700 temp
// dir removed in `finally`.
//
// usage: node out/build767/live-check.mjs <source mcp-config.json> [lanes=3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { codexThreadConfig } from '../../server/dist/providers/agentsMcp.js';
import { AppServerClient } from '../../server/dist/providers/codexAppServer/protocol.js';
import { proServiceEnv } from '../../server/dist/homes.js';

const [source, lanesArg] = process.argv.slice(2);
const lanes = Number(lanesArg ?? 3);
const HELP = 'gmail-help-elkhartrvparts-com-everyone-4';
const CODEX_HOME = '/Users/archerclawdington/veneer-pro-home/.codex-accounts/feda030e-86bb-406a-811e-3334cb761355';
const codexBin = execFileSync('/bin/zsh', ['-lc', 'command -v codex']).toString().trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build767-live-'));
fs.chmodSync(tmp, 0o700);
const client = new AppServerClient({ codexBin, env: { ...proServiceEnv(), CODEX_HOME }, log: console });
try {
  const all = JSON.parse(fs.readFileSync(source, 'utf8')).mcpServers;
  // Remote (Composio + Runway) servers only: no agents/browser token servers.
  const remote = Object.fromEntries(Object.entries(all).filter(([, s]) => s.url && !String(s.url).includes(':3101/')));
  const cfgPath = path.join(tmp, 'mcp-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: remote }), { mode: 0o600 });
  const config = codexThreadConfig(cfgPath);
  // Unattended test thread: pre-approve only the one read-only tool.
  config.mcp_servers[HELP].tools = { GMAIL_GET_PROFILE: { approval_mode: 'approve' } };
  console.log(`servers: ${Object.keys(config.mcp_servers).join(', ')}`);
  console.log(`grace_ms=${config.mcp_optional_startup_grace_ms} startup_timeout_sec=${config.mcp_servers[HELP].startup_timeout_sec} bridge=${path.basename(config.mcp_servers[HELP].args[0])}`);

  const t0 = Date.now();
  const lane = async (n) => {
    const started = await client.request('thread/start', {
      cwd: tmp,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      config,
      developerInstructions: 'Build #767 live MCP check. Read-only. Make exactly one tool call.',
    });
    const threadId = started.thread.id;
    const result = { lane: n, threadId, calls: [], text: '', status: 'pending' };
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => { result.status = 'timeout'; resolve(); }, 240_000);
      client.subscribe(threadId, (msg) => {
        const item = msg.params?.item;
        if (msg.method === 'item/completed' && item?.type === 'mcpToolCall') {
          const text = JSON.stringify(item.result ?? item.error ?? null);
          result.calls.push({ server: item.server, tool: item.tool, status: item.status, email: /help@elkhartrvparts\.com/.test(text) ? 'help@elkhartrvparts.com' : null, error: item.error ? String(item.error.message ?? text).slice(0, 200) : null });
        }
        if (msg.method === 'item/completed' && item?.type === 'agentMessage') result.text = String(item.text ?? '').slice(0, 200);
        if (msg.method === 'turn/completed') { result.status = msg.params?.turn?.status ?? 'completed'; clearTimeout(timer); resolve(); }
      });
    });
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: `Call the MCP tool GMAIL_GET_PROFILE on the ${HELP} server with user_id "me". Make no other tool call. Reply with only the emailAddress it returns, or the exact error if the call fails.` }],
    });
    await done;
    result.seconds = Math.round((Date.now() - t0) / 1000);
    return result;
  };
  const results = await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i + 1)));
  for (const r of results) console.log(JSON.stringify(r));
} finally {
  client.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
}
