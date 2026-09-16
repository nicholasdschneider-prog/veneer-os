#!/usr/bin/env node
// Live deployment smoke test. Creates one temporary private chat, uses real MCP
// and HTTP authentication, and removes its browser copy, token and chat afterward.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadEnvFile } from '../server/dist/envFile.js';
import { loadConfig } from '../server/dist/config.js';
import { mintAgentToken } from '../server/dist/runtime/agentTokens.js';

loadEnvFile();
const config = loadConfig();
const db = new Database(path.join(config.dataDir, 'veneer-pro.db'));
const chatId = randomUUID();
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let token;
let child;
let created = false;
let browserStarted = false;
let cleaned = true;

async function browserRpc(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${config.runnerPort}/mcp/veneer-browser`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-vp-agent-token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(300000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Browser MCP endpoint failed');
  const message = await response.json();
  if (message.error || message.result?.isError) throw new Error('Browser MCP operation failed');
  return message.result;
}

try {
  const user = db.prepare("SELECT id,email FROM users WHERE status='active' ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END,id LIMIT 1").get();
  const assistant = db.prepare("SELECT id FROM assistants WHERE deleted_at IS NULL ORDER BY CASE WHEN slug='assistant' THEN 0 ELSE 1 END,id LIMIT 1").get();
  if (!user || !assistant || !config.appPublicOrigin) throw new Error('An active user, assistant and public origin are required');
  db.prepare("INSERT INTO conversations (id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES (?,?,?,?,?,?,?)")
    .run(chatId, assistant.id, user.id, 'Deployment verification', 'codex', randomUUID(), 'private');
  created = true;
  token = mintAgentToken(db, user.email, chatId);
  child = spawn(process.execPath, [path.join(appRoot, 'server/dist/mcp/agentToolsServer.js')], {
    env: { ...process.env, VP_AGENT_TOKEN: token, VP_AGENT_TOKEN_FILE: '', VP_CONVERSATION_ID: chatId,
      VP_INTERNAL_BASE_URL: `http://127.0.0.1:${config.port}` },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const message = JSON.parse(line); pending.get(message.id)?.(message); } catch { /* no page or credential logging */ }
  });
  let sequence = 0;
  const rpc = async (method, params = {}) => {
    const id = ++sequence;
    let timer;
    try {
      const message = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Agent tool timed out')), 20000);
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      if (message.error || message.result?.isError) throw new Error('Agent tool failed');
      return message.result;
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const advertised = await rpc('tools/list');
  if (!advertised.tools.some(tool => tool.name === 'get_chat_link')) throw new Error('Chat link tool not advertised');
  const linkResult = await rpc('tools/call', { name: 'get_chat_link', arguments: {} });
  const link = JSON.parse(linkResult.content.find(item => item.type === 'text').text);
  const origin = new URL(config.appPublicOrigin);
  if (link.url !== `${origin.origin}${origin.pathname}#/chat/${chatId}`) throw new Error('Chat link does not match the configured client URL');
  const browserTools = await browserRpc('tools/list');
  if (!browserTools.tools.some(tool => tool.name === 'fetch_url')) throw new Error('Browser URL tool not advertised');
  browserStarted = true;
  const result = await browserRpc('tools/call', { name: 'fetch_url', arguments: {
    url: 'https://example.com/', wait_for: { text: 'Example Domain' }, timeout_ms: 60000, max_chars: 1000,
  } });
  const read = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  if (!read.ok || !read.text.includes('Example Domain')) throw new Error('Browser URL read did not return expected content');
  console.log(JSON.stringify({ origin: origin.origin, chat_link: true, browser_fetch: true, characters: read.text.length }));
} catch (error) {
  // Transport errors can contain secret addresses; emit only our fixed messages.
  console.error('Chat tool deployment verification failed. Inspect the client health and tool availability.');
  process.exitCode = 1;
} finally {
  if (browserStarted) {
    try { await browserRpc('tools/call', { name: 'stop', arguments: {} }); }
    catch { cleaned = false; process.exitCode = 1; console.error('Verification browser cleanup failed.'); }
  }
  child?.kill('SIGTERM');
  if (token) db.prepare('DELETE FROM agent_tokens WHERE token=?').run(token);
  if (created && cleaned) db.prepare('DELETE FROM conversations WHERE id=?').run(chatId);
  db.close();
}
