import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import type { UserRow, ConversationRow } from '../db/db.js';
import {
  businessScopeSql,
  businessAgentSql,
  canViewConversation,
} from '../conversations/access.js';
import { sanitizeMemoryText } from '../memory/capture.js';
import { queueNotification } from './notifications.js';

export function indexDocument(
  ctx: AppContext,
  id: string,
  c: string,
  kind: string,
  body: string,
  at: string,
  href: string,
) {
  const clean = sanitizeMemoryText(body).slice(0, 100000);
  if (!clean.trim()) return;
  ctx.db
    .prepare(
      `INSERT INTO bot_search_documents(id,conversation_id,kind,body,at,href) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,at=excluded.at,href=excluded.href`,
    )
    .run(id, c, kind, clean, at, href);
}
export async function indexConversation(ctx: AppContext, c: ConversationRow) {
  const events = await ctx.manager.snapshot(c.id);
  ctx.db.transaction(() => {
    for (const e of events) {
      if (e.type !== 'turn_started' && e.type !== 'text_final') continue;
      const role = e.type === 'text_final' ? 'assistant' : 'user';
      const text = e.type === 'text_final' ? e.markdown : (e.text ?? '');
      const anchor = JSON.stringify({ turn: e.turnId, role, at: e.at });
      const id = crypto
        .createHash('sha256')
        .update(c.id + anchor + text)
        .digest('hex');
      indexDocument(
        ctx,
        id,
        c.id,
        role,
        text,
        e.at,
        `#/chat/${encodeURIComponent(c.id)}?message=${encodeURIComponent('search:' + anchor)}`,
      );
      if (e.type === 'text_final')
        queueNotification(
          ctx,
          c.id,
          `turn:${c.id}:${e.turnId}`,
          'completed',
          `#/chat/${c.id}`,
          e.at,
        );
    }
    ctx.db
      .prepare(
        'INSERT INTO bot_search_progress(conversation_id,indexed_activity_at) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET indexed_activity_at=excluded.indexed_activity_at',
      )
      .run(c.id, c.last_active_at);
  })();
}
export async function tickSearch(ctx: AppContext) {
  for (const c of ctx.db
    .prepare(
      `SELECT c.* FROM conversations c LEFT JOIN bot_search_progress p ON p.conversation_id=c.id WHERE p.conversation_id IS NULL OR p.indexed_activity_at<c.last_active_at ORDER BY c.last_active_at DESC LIMIT 4`,
    )
    .all() as ConversationRow[]) {
    try {
      await indexConversation(ctx, c);
    } catch {
      /* Leave progress untouched and retry next sweep. */
    }
  }
  // Upserts are restricted to changed rows. Never index raw proposal metadata or tool payloads.
  for (const d of ctx.db
    .prepare(
      `SELECT d.* FROM bot_decisions d LEFT JOIN bot_search_documents s ON s.id='decision:'||d.id WHERE s.id IS NULL OR s.at<d.updated_at`,
    )
    .all() as {
    id: string;
    conversation_id: string;
    proposal_json: string;
    answer_json: string | null;
    result_json: string | null;
    updated_at: string;
  }[]) {
    const p = JSON.parse(d.proposal_json) as Record<string, unknown>;
    const body = [
      p.question,
      p.recommendation,
      p.blocked_action,
      d.answer_json ? JSON.parse(d.answer_json).text : '',
      d.result_json ? JSON.parse(d.result_json).evidence : '',
    ]
      .filter((v) => typeof v === 'string')
      .join('\n');
    indexDocument(
      ctx,
      `decision:${d.id}`,
      d.conversation_id,
      'decision',
      body,
      d.updated_at,
      `#/bots/${d.id}`,
    );
  }
  for (const m of ctx.db
    .prepare(
      `SELECT m.*,h.lead_conversation_id FROM huddle_messages m JOIN huddles h ON h.id=m.huddle_id LEFT JOIN bot_search_documents s ON s.id='huddle:'||m.id WHERE s.id IS NULL`,
    )
    .all() as {
    id: string;
    huddle_id: string;
    lead_conversation_id: string;
    body: string;
    created_at: string;
    seq: number;
  }[])
    indexDocument(
      ctx,
      `huddle:${m.id}`,
      m.lead_conversation_id,
      'huddle',
      m.body,
      m.created_at,
      `#/huddles/${m.huddle_id}?message=${m.id}`,
    );
}
export function searchWork(
  ctx: AppContext,
  user: UserRow,
  query: string,
  offset = 0,
  source?: string,
) {
  const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
  if (!words.length) return { results: [], hasMore: false, indexing: 0 };
  const match = words
    .map((t) => '"' + t.replaceAll('"', '""') + '"*')
    .join(' AND ');
  const agentHuddle = source
    ? ` AND (s.kind<>'huddle' OR EXISTS(SELECT 1 FROM huddle_messages hm JOIN huddle_members mem ON mem.huddle_id=hm.huddle_id WHERE 'huddle:'||hm.id=s.id AND mem.conversation_id='${source.replaceAll("'", "''")}'))`
    : '';
  const scope = `(c.visibility='team' OR c.user_id=${user.id}) AND ${businessScopeSql(user.id)} AND ${businessAgentSql(ctx.db, source)}`;
  const rows = ctx.db
    .prepare(
      `SELECT s.id,s.kind,s.body,s.at,s.href,c.id AS conversation_id,c.title FROM bot_search_fts f JOIN bot_search_documents s ON s.rowid=f.rowid JOIN conversations c ON c.id=s.conversation_id WHERE bot_search_fts MATCH ? AND ${scope}${agentHuddle} ORDER BY rank,s.at DESC LIMIT 31 OFFSET ?`,
    )
    .all(match, offset) as {
    id: string;
    kind: string;
    body: string;
    at: string;
    href: string;
    conversation_id: string;
    title: string;
  }[];
  const results = rows.slice(0, 30).map(({ body, ...r }) => {
    const start = Math.max(
      0,
      body.toLowerCase().indexOf(words[0]!.toLowerCase()) - 90,
    );
    return {
      ...r,
      excerpt:
        (start ? '…' : '') +
        body.slice(start, start + 320) +
        (start + 320 < body.length ? '…' : ''),
    };
  });
  const indexing = (
    ctx.db
      .prepare(
        `SELECT count(*) AS n FROM conversations c LEFT JOIN bot_search_progress p ON p.conversation_id=c.id WHERE ${scope} AND (p.conversation_id IS NULL OR p.indexed_activity_at<c.last_active_at)`,
      )
      .get() as { n: number }
  ).n;
  return { results, hasMore: rows.length > 30, indexing };
}
