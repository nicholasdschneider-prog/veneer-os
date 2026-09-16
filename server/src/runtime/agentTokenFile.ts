import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex App Server persists an MCP server's original environment with the
 * native thread, so a resumed thread can relaunch that server with an expired
 * VP_AGENT_TOKEN even though the current turn materialized a fresh one. Keep a
 * tiny per-conversation indirection file that local MCP processes can read at
 * call time. The database token remains the authority and still expires.
 */

function defaultTokenDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `veneer-pro-agent-tokens-${uid}`);
}

function safeConversationId(conversationId: string): string | null {
  return /^[A-Za-z0-9-]{1,128}$/.test(conversationId) ? conversationId : null;
}

export function agentTokenFilePath(conversationId: string, tokenDir = defaultTokenDir()): string | null {
  const safeId = safeConversationId(conversationId);
  return safeId ? path.join(tokenDir, safeId) : null;
}

export function writeCurrentAgentToken(
  conversationId: string,
  token: string,
  tokenDir = defaultTokenDir(),
): string | null {
  const file = agentTokenFilePath(conversationId, tokenDir);
  if (!file || !token) return null;
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function readCurrentAgentToken(conversationId: string, tokenFile?: string): string | null {
  const file = tokenFile?.trim() || agentTokenFilePath(conversationId);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function resolveCurrentAgentToken(
  environmentToken: string,
  conversationId: string,
  tokenFile?: string,
): string {
  return readCurrentAgentToken(conversationId, tokenFile) ?? environmentToken;
}
