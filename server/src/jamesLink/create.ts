import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { ensureConversationInstructionSnapshot } from '../instructions/context.js';

/**
 * Start a chat for James the way the web New chat does for the owner: the
 * project's default agent (else the site default, else the ordinary
 * assistant, never Platform Dev or Skill Builder) on that agent's or the site's
 * default provider, model and effort.
 */

const ADMIN_ONLY = new Set(['platform-dev', 'skill-smith']);

interface Prefs {
  defaultProvider?: string;
  providerDefaults?: Record<string, string | null>;
  defaultEffort?: string | null;
  defaultAgent?: string | null;
  agents?: Record<string, { provider?: string | null; model?: string | null; effort?: string | null }>;
}

export class UnknownProjectError extends Error {}

export function createJamesConversation(
  db: Database.Database,
  input: { projectId: string | null; title: string },
): string {
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (!owner) throw new Error('No owner account.');
  let projectDefault: string | null = null;
  if (input.projectId) {
    const project = db.prepare(
      `SELECT p.id, a.slug AS default_agent FROM projects p
         LEFT JOIN assistants a ON a.id = p.default_assistant_id AND a.deleted_at IS NULL
        WHERE p.id = ?`,
    ).get(input.projectId) as { id: string; default_agent: string | null } | undefined;
    if (!project) throw new UnknownProjectError('Unknown project');
    projectDefault = project.default_agent;
  }
  let prefs: Prefs = {};
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as { value_json: string } | undefined;
    if (row) prefs = JSON.parse(row.value_json) as Prefs;
  } catch { /* defaults below */ }
  const available = (db.prepare('SELECT id, slug FROM assistants WHERE deleted_at IS NULL ORDER BY id').all() as { id: number; slug: string }[])
    .filter((a) => !ADMIN_ONLY.has(a.slug));
  let assistant: { id: number; slug: string } | undefined;
  for (const preferred of [projectDefault, prefs.defaultAgent ?? null, 'assistant']) {
    if (preferred) assistant = available.find((a) => a.slug === preferred);
    if (assistant) break;
  }
  assistant ??= available[0];
  if (!assistant) throw new Error('No agent is available');
  const agentPrefs = prefs.agents?.[assistant.slug];
  const provider = agentPrefs?.provider ?? prefs.defaultProvider ?? 'claude';
  const model = agentPrefs?.model ?? prefs.providerDefaults?.[provider] ?? null;
  const effort = agentPrefs?.effort ?? prefs.defaultEffort ?? null;
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO conversations
         (id, assistant_id, user_id, visibility, project_id, title, title_auto, provider, model, effort, native_session_id, channel, last_user_activity_at)
       VALUES (?, ?, ?, 'team', ?, ?, 0, ?, ?, ?, ?, 'web', datetime('now'))`,
    ).run(id, assistant.id, owner.id, input.projectId, input.title.slice(0, 200), provider, model, effort, crypto.randomUUID());
    ensureConversationInstructionSnapshot(db, id);
  })();
  return id;
}
