import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow, UserRow } from '../db/db.js';
import { sanitizeMemoryText } from '../memory/capture.js';
import type { ConversationStatus } from '../runtime/events.js';

const MAX_LIMIT = 50;
const MAX_OFFSET = 10_000;
const MAX_DYNAMIC_SCAN = 200;
const PREVIEW_LENGTH = 240;
const SNAPSHOT_CONCURRENCY = 10;
const ISO_DATE_OR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const ActiveSinceSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => ISO_DATE_OR_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
    'activeSince must be an ISO date or timestamp',
  );

export const RecentConversationsQuerySchema = z.object({
  projectId: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['working', 'idle', 'needs_you', 'failed']).optional(),
  activeSince: ActiveSinceSchema.optional(),
  query: z.string().trim().max(200).optional().default(''),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(20),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional().default(0),
});

interface RecentConversationRow extends ConversationRow {
  project_name: string | null;
  project_slug: string | null;
  assistant_slug: string | null;
  assistant_name: string | null;
}

export interface RecentMessagePreview {
  role: 'user' | 'agent';
  text: string;
  at: string | null;
}

export interface RecentConversationView {
  conversationId: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  assistantSlug: string;
  assistantName: string;
  provider: ConversationRow['provider'];
  model: string | null;
  channel: ConversationRow['channel'];
  status: ConversationStatus;
  archived: boolean;
  updatedAt: string;
  lastUserActivityAt: string | null;
  lastAgentActivityAt: string | null;
  preview: RecentMessagePreview | null;
}

interface ActivitySummary {
  lastAgentActivityAt: string | null;
  preview: RecentMessagePreview | null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function isoTimestamp(value: unknown): string | null {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function previewText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = sanitizeMemoryText(value).replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

/**
 * Read only user-visible messages. System text, reasoning, and tool inputs or
 * outputs never enter the discovery preview.
 */
export function summarizeRecentActivity(events: unknown[]): ActivitySummary {
  let lastAgentMs: number | null = null;
  let preview: RecentMessagePreview | null = null;

  for (const raw of events) {
    const event = (raw ?? {}) as Record<string, unknown>;
    if (event.type !== 'turn_started' && event.type !== 'text_final') continue;
    const role = event.type === 'turn_started' ? 'user' : 'agent';
    const text = previewText(event.type === 'turn_started' ? event.text : event.markdown);
    const at = isoTimestamp(event.at);
    if (role === 'agent') {
      const ms = timestampMs(event.at);
      if (ms !== null && (lastAgentMs === null || ms > lastAgentMs)) lastAgentMs = ms;
    }
    if (text) preview = { role, text, at };
  }

  return {
    lastAgentActivityAt: lastAgentMs === null ? null : new Date(lastAgentMs).toISOString(),
    preview,
  };
}

function sqliteTimestamp(value: string): string {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

function matchesQuery(conversation: RecentConversationView, query: string): boolean {
  if (!query) return true;
  const haystack = [
    conversation.conversationId,
    conversation.title,
    conversation.projectId,
    conversation.projectName,
    conversation.projectSlug,
    conversation.assistantSlug,
    conversation.assistantName,
    conversation.provider,
    conversation.model,
    conversation.preview?.text,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += SNAPSHOT_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(index, index + SNAPSHOT_CONCURRENCY).map(run))));
  }
  return results;
}

export function createRecentConversationsRouter(
  ctx: AppContext,
  options: {
    refreshAutoArchive: (userId: number) => void;
    conversationView: (row: ConversationRow, viewer: UserRow) => Promise<Record<string, unknown>>;
  },
): Router {
  const router = express.Router();

  router.get('/', (req, res) => {
    void (async () => {
      const parsed = RecentConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ ok: false, error: 'Invalid recent-conversation query' });
        return;
      }
      const input = parsed.data;
      options.refreshAutoArchive(req.user!.id);

      const where = ["(c.visibility = 'team' OR c.user_id = ?)"];
      const params: unknown[] = [req.user!.id];
      if (!input.includeArchived) where.push('c.archived = 0');
      if (input.projectId === 'none') where.push('c.project_id IS NULL');
      else if (input.projectId) {
        where.push('c.project_id = ?');
        params.push(input.projectId);
      }
      if (input.activeSince) {
        where.push('c.last_active_at >= ?');
        params.push(sqliteTimestamp(input.activeSince));
      }

      const dynamicFilter = Boolean(input.status || input.query);
      const scanLimit = dynamicFilter ? MAX_DYNAMIC_SCAN : input.limit;
      const rows = ctx.db
        .prepare(
          `SELECT c.*,
                  p.name AS project_name,
                  p.slug AS project_slug,
                  a.slug AS assistant_slug,
                  a.name AS assistant_name
             FROM conversations c
             LEFT JOIN projects p ON p.id = c.project_id
             LEFT JOIN assistants a ON a.id = c.assistant_id
            WHERE ${where.join(' AND ')}
            ORDER BY c.last_active_at DESC, c.rowid DESC
            LIMIT ? OFFSET ?`,
        )
        .all(...params, scanLimit + 1, input.offset) as RecentConversationRow[];
      const hasMoreBaseRows = rows.length > scanLimit;
      const candidates = rows.slice(0, scanLimit);

      const built = await inBatches(candidates, async (row): Promise<RecentConversationView> => {
        const [base, events] = await Promise.all([
          options.conversationView(row, req.user!),
          ctx.manager.snapshot(row.id).catch(() => []),
        ]);
        const activity = summarizeRecentActivity(events);
        return {
          conversationId: row.id,
          title: row.title,
          projectId: row.project_id,
          projectName: row.project_name,
          projectSlug: row.project_slug,
          assistantSlug: row.assistant_slug ?? String(base.assistantSlug ?? 'assistant'),
          assistantName: row.assistant_name ?? String(base.assistantName ?? 'Assistant'),
          provider: row.provider,
          model: row.model,
          channel: row.channel,
          status: String(base.status) as ConversationStatus,
          archived: Boolean(row.archived),
          updatedAt: isoTimestamp(row.last_active_at) ?? row.last_active_at,
          lastUserActivityAt: isoTimestamp(row.last_user_activity_at),
          lastAgentActivityAt: activity.lastAgentActivityAt,
          preview: activity.preview,
        };
      });

      const matching = built
        .map((conversation, baseIndex) => ({ conversation, baseIndex }))
        .filter(
          ({ conversation }) =>
            (!input.status || conversation.status === input.status) && matchesQuery(conversation, input.query),
        );
      const selected = matching.slice(0, input.limit);

      let nextOffset: number | null = null;
      if (matching.length > input.limit) {
        nextOffset = input.offset + selected[selected.length - 1]!.baseIndex + 1;
      } else if (hasMoreBaseRows) {
        nextOffset = input.offset + candidates.length;
      }

      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        conversations: selected.map(({ conversation }) => conversation),
        page: {
          limit: input.limit,
          offset: input.offset,
          scanned: candidates.length,
          nextOffset,
          hasMore: nextOffset !== null,
        },
      });
    })().catch((error: Error) => res.status(500).json({ ok: false, error: error.message }));
  });

  return router;
}
