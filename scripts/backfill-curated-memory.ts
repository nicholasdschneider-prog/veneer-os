import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db/db.js';
import type { ConversationRow } from '../server/src/db/db.js';
import { memoryMessagesFromEvents } from '../server/src/memory/capture.js';
import { curateConversationMemory } from '../server/src/memory/curator.js';
import { createSupermemoryClient } from '../server/src/memory/supermemory.js';
import { readClaudeTranscript } from '../server/src/providers/claude/transcript.js';
import { readCodexTranscript } from '../server/src/providers/codex/transcript.js';
import type { ConversationEvent } from '../server/src/runtime/events.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const client = createSupermemoryClient({ baseUrl: config.supermemoryBaseUrl, apiKey: config.supermemoryApiKey });
if (!client.configured) throw new Error('SUPERMEMORY_API_KEY is not configured.');

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(12, Number(limitArg?.split('=')[1] ?? 4) || 4));
const runAll = process.argv.includes('--all');
const concurrencyArg = process.argv.find((arg) => arg.startsWith('--concurrency='));
const concurrency = Math.max(1, Math.min(4, Number(concurrencyArg?.split('=')[1] ?? (runAll ? 4 : 1)) || 1));
const excludedConversationIds = new Set(
  process.argv
    .filter((arg) => arg.startsWith('--exclude='))
    .flatMap((arg) => (arg.split('=')[1] ?? '').split(','))
    .map((id) => id.trim())
    .filter(Boolean),
);
const includedConversationIds = new Set(
  process.argv
    .filter((arg) => arg.startsWith('--include='))
    .flatMap((arg) => (arg.split('=')[1] ?? '').split(','))
    .map((id) => id.trim())
    .filter(Boolean),
);
const assistantSlugs = new Map<number, string>(
  (db.prepare('SELECT id, slug FROM assistants').all() as { id: number; slug: string }[]).map((row) => [row.id, row.slug]),
);
const projects = new Map<string, { name: string; slug: string; root_dir: string | null }>(
  (db.prepare('SELECT id, name, slug, root_dir FROM projects').all() as {
    id: string; name: string; slug: string; root_dir: string | null;
  }[]).map((row) => [row.id, { name: row.name, slug: row.slug, root_dir: row.root_dir }]),
);
const veneerProjectId = [...projects.entries()].find(([, project]) =>
  project.root_dir === config.sourceDir || project.slug === 'veneer-pro')?.[0] ?? null;

function scopedConversation(conversation: ConversationRow): ConversationRow {
  if (conversation.project_id || assistantSlugs.get(conversation.assistant_id) !== 'platform-dev' || !veneerProjectId) {
    return conversation;
  }
  // Projects were added after many Platform Dev chats already existed. Their
  // source workspace is unambiguously Veneer Pro, so backfill them into that
  // project rather than leaking product decisions into global memory.
  return { ...conversation, project_id: veneerProjectId };
}

function cwdFor(conv: ConversationRow): string {
  const assistantSlug = assistantSlugs.get(conv.assistant_id) ?? 'assistant';
  if (assistantSlug === 'platform-dev') return config.sourceDir;
  const project = conv.project_id ? projects.get(conv.project_id) : null;
  if (project) return project.root_dir ?? path.join(config.dataDir, 'workspaces', 'projects', project.slug);
  return path.join(config.dataDir, 'workspaces', assistantSlug);
}

async function transcriptFor(conv: ConversationRow): Promise<ConversationEvent[]> {
  const cwd = cwdFor(conv);
  if (conv.provider === 'claude') return readClaudeTranscript(cwd, conv.native_session_id);
  if (conv.provider === 'openrouter') {
    return readClaudeTranscript(cwd, conv.native_session_id, path.join(config.dataDir, 'claude-openrouter'));
  }
  const [legacy, current] = await Promise.all([
    readCodexTranscript(path.join(config.dataDir, 'codex-transcripts'), conv.native_session_id),
    readCodexTranscript(path.join(config.dataDir, 'codex-app-server-transcripts'), conv.native_session_id),
  ]);
  return [...legacy, ...current];
}

const recent = db.prepare(
  `SELECT c.* FROM conversations c
   WHERE NOT EXISTS (SELECT 1 FROM pending_turns p WHERE p.conversation_id = c.id)
   ORDER BY c.last_active_at DESC${runAll ? '' : ' LIMIT 30'}`,
).all() as ConversationRow[];
const transcripts = await Promise.all(recent.map(async (conversation) => {
  const messages = memoryMessagesFromEvents(await transcriptFor(conversation));
  return {
    conversation,
    messages,
    chars: messages.reduce((sum, message) => sum + message.content.length, 0),
  };
}));
const eligible = transcripts
  .filter(({ conversation, messages }) =>
    !excludedConversationIds.has(conversation.id) &&
    (includedConversationIds.size === 0 || includedConversationIds.has(conversation.id)) &&
    messages.some((message) => message.role === 'user'));
const selected = runAll
  ? eligible.sort((a, b) => a.conversation.last_active_at.localeCompare(b.conversation.last_active_at))
  : eligible.sort((a, b) => b.chars - a.chars).slice(0, limit);

let saved = 0;
let suggested = 0;
let skipped = 0;
let failed = 0;
const audit: Record<string, unknown>[] = [];

async function curateOne(item: (typeof selected)[number]): Promise<Record<string, unknown>> {
  const conversation = scopedConversation(item.conversation);
  const project = conversation.project_id ? projects.get(conversation.project_id) : null;
  try {
    const result = await curateConversationMemory({
      db,
      client,
      codexBin: config.codexBin,
      conversation,
      messages: item.messages,
      projectName: project?.name,
    });
    return {
      conversationId: item.conversation.id,
      title: item.conversation.title,
      lastActiveAt: item.conversation.last_active_at,
      projectId: conversation.project_id,
      characters: item.chars,
      proposed: result.proposed.length,
      saved: result.saved.map((candidate) => ({ scope: candidate.scope, kind: candidate.kind, content: candidate.content })),
      suggested: result.suggested.map((candidate) => ({ scope: candidate.scope, kind: candidate.kind, content: candidate.content })),
      skipped: result.skipped.length,
      rejectionReasons: result.rejectionReasons.reduce<Record<string, number>>((counts, reason) => {
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      }, {}),
      rejected: result.skipped.map((candidate, candidateIndex) => ({
        reason: result.rejectionReasons[candidateIndex] ?? 'unknown',
        content: result.rejectionReasons[candidateIndex] === 'sensitive' ? '[redacted]' : candidate.content,
      })),
    };
  } catch (error) {
    return {
      conversationId: item.conversation.id,
      title: item.conversation.title,
      lastActiveAt: item.conversation.last_active_at,
      projectId: conversation.project_id,
      characters: item.chars,
      proposed: 0,
      saved: [],
      suggested: [],
      skipped: 0,
      rejectionReasons: {},
      rejected: [],
      error: (error as Error).message,
    };
  }
}

for (let offset = 0; offset < selected.length; offset += concurrency) {
  const batch = selected.slice(offset, offset + concurrency);
  const rows = await Promise.all(batch.map(curateOne));
  for (const row of rows) {
    const rowSaved = row.saved as unknown[];
    const rowSuggested = row.suggested as unknown[];
    saved += rowSaved.length;
    suggested += rowSuggested.length;
    skipped += Number(row.skipped ?? 0);
    if (row.error) failed += 1;
    audit.push(row);
    console.log(`[curated-backfill] ${audit.length}/${selected.length} ${JSON.stringify(row)}`);
  }
}

if (runAll) {
  const auditPath = path.join(config.dataDir, 'memory-curator-backfill-audit.json');
  await fs.writeFile(auditPath, JSON.stringify({ createdAt: new Date().toISOString(), conversations: audit }, null, 2), {
    mode: 0o600,
  });
  console.log(`[curated-backfill] audit=${auditPath}`);
}
console.log(`CURATED_BACKFILL_RESULT ${JSON.stringify({ conversations: selected.length, saved, suggested, skipped, failed })}`);
if (failed) process.exitCode = 1;
