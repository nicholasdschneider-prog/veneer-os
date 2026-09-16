import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Short-lived tokens that let a conversation's spawned agent call back into
 * our REST API as the authenticated user who initiated that turn (spec: agents
 * may reference/message other chats the user can already see). Minted fresh per
 * turn, carried to the agent-tools MCP server via an env var, presented as
 * `X-VP-Agent-Token` — index.ts's identity resolver treats a valid token
 * exactly like a verified human identity, so every existing authorization
 * check (member/owner/consultant scoping) applies unchanged.
 *
 * Tokens live in the shared SQLite DB (`agent_tokens`) rather than in-process
 * memory: with the web/runner process split the runner mints a token and the
 * web process resolves it, so the two ends no longer share a Map.
 */

// Must outlive the longest possible turn: the token is minted once at turn
// start with no mid-turn refresh, so a TTL shorter than the watchdog ceiling
// (VP_TURN_TIMEOUT_MS, default 6 h) made hours-long agents lose every
// agents-MCP call (403 "No identity") once the mint aged out. Track the
// configured ceiling plus an hour of slack.
const configuredTurnCeilingMs = Number(process.env.VP_TURN_TIMEOUT_MS) || 6 * 60 * 60 * 1000;
const TTL_MS = configuredTurnCeilingMs + 60 * 60 * 1000;

export function mintAgentToken(db: Database.Database, email: string, conversationId: string | null = null): string {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO agent_tokens (token, email, expires_at, conversation_id) VALUES (?, ?, ?, ?)').run(
    token,
    email,
    Date.now() + TTL_MS,
    conversationId,
  );
  return token;
}

export interface AgentTokenContext {
  email: string;
  conversationId: string | null;
}

/** Resolve the authenticated user plus the conversation this turn belongs to. */
export function resolveAgentTokenContext(db: Database.Database, token: string): AgentTokenContext | null {
  const row = db.prepare('SELECT email, expires_at, conversation_id FROM agent_tokens WHERE token = ?').get(token) as
    | { email: string; expires_at: number; conversation_id: string | null }
    | undefined;
  db.prepare('DELETE FROM agent_tokens WHERE expires_at < ?').run(Date.now());
  if (!row || row.expires_at < Date.now()) return null;
  return { email: row.email, conversationId: row.conversation_id };
}

export function resolveAgentToken(db: Database.Database, token: string): string | null {
  return resolveAgentTokenContext(db, token)?.email ?? null;
}
