import { businessScopeSql } from '../conversations/access.js';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow, UserConnectorRow } from '../db/db.js';
import { connectedConnectorRowsForConversation } from '../connectors/access.js';
import { connectorDef, type ComposioInstallConfig } from '../connectors/catalog.js';
import { connectorAccessModeProfile } from '../connectors/accessModes.js';
import {
  composioErrorMessage,
  createComposioGmailDraft,
  updateComposioGmailDraft,
  type ComposioGmailDraftResult,
} from '../connectors/composio.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import { createWorkspaceResolver } from '../runtime/buildAgentRuntime.js';

const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const DENIED_SEGMENTS = new Set([
  '.aws', '.claude', '.codex', '.doppler', '.git', '.gnupg', '.grok', '.ssh', 'node_modules',
]);
const DENIED_NAMES = new Set(['.env', '.npmrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json']);
const DENIED_EXTS = new Set(['.db', '.key', '.p12', '.pem', '.pfx', '.sqlite', '.sqlite3']);

const DraftSchema = z.object({
  account: z.string().trim().min(1).max(80).optional(),
  to: z.array(z.string().trim().email().max(320)).min(1).max(20),
  cc: z.array(z.string().trim().email().max(320)).max(20).optional(),
  bcc: z.array(z.string().trim().email().max(320)).max(20).optional(),
  subject: z.string().max(998),
  body: z.string().max(1_000_000),
  isHtml: z.boolean().optional(),
  attachments: z.array(z.string().trim().min(1).max(4096)).min(1).max(10),
});

/** GMAIL_UPDATE_DRAFT replaces the whole draft, so the caller supplies complete content. */
const DraftUpdateSchema = DraftSchema.extend({
  draft_id: z.string().trim().min(1).max(200),
  thread_id: z.string().trim().min(1).max(200).optional(),
});

export interface GmailDraftsRouterDependencies {
  createDraft?: typeof createComposioGmailDraft;
  updateDraft?: typeof updateComposioGmailDraft;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sensitivePath(candidate: string): boolean {
  const parts = candidate.split(path.sep).filter(Boolean);
  const name = path.basename(candidate).toLowerCase();
  return parts.some((part) => DENIED_SEGMENTS.has(part.toLowerCase())) ||
    DENIED_NAMES.has(name) || DENIED_EXTS.has(path.extname(name));
}

function eligibleGmailRows(
  ctx: AppContext,
  conversationId: string,
  actorUserId: number,
  requiredSlugs: readonly string[] = ['GMAIL_CREATE_EMAIL_DRAFT'],
): UserConnectorRow[] {
  const def = connectorDef('gmail');
  return connectedConnectorRowsForConversation(ctx.db, conversationId, actorUserId).filter((row) => {
    if (row.connector_slug !== 'gmail') return false;
    const profile = connectorAccessModeProfile(def?.accessModes, row.access_mode, row.access_version);
    const slugs = profile?.composio?.toolSlugs ?? [];
    return requiredSlugs.every((slug) => slugs.includes(slug));
  });
}

function selectGmailRow(rows: UserConnectorRow[], account?: string): UserConnectorRow {
  const requested = account?.trim().toLowerCase();
  if (requested) {
    const found = rows.filter((row) => row.label?.trim().toLowerCase() === requested);
    if (found.length === 1) return found[0]!;
    throw new Error(`No writable Gmail connection named "${account}" is available to this chat.`);
  }
  if (rows.length === 1) return rows[0]!;
  if (!rows.length) throw new Error('This chat has no writable Gmail connection. Connect Gmail with Full access first.');
  const labels = rows.map((row) => row.label || 'Unlabeled').join(', ');
  throw new Error(`More than one Gmail connection is available. Choose account: ${labels}.`);
}

function registeredFilePaths(ctx: AppContext, conversation: ConversationRow): Set<string> {
  const rows = ctx.db.prepare(
    `SELECT g.path
       FROM generated_files g
       LEFT JOIN conversations c ON c.id = g.conversation_id
      WHERE (g.user_id = ? OR c.visibility = 'team') AND ${businessScopeSql(conversation.user_id)} AND (c.business_team_id IS NULL OR c.business_team_id IS (SELECT business_team_id FROM conversations WHERE id=?))`,
  ).all(conversation.user_id, conversation.id) as { path: string }[];
  return new Set(rows.map((row) => row.path));
}

function resolveAttachments(
  ctx: AppContext,
  conversation: ConversationRow,
  inputs: string[],
): string[] {
  const firstAssistant = ctx.db.prepare(
    'SELECT slug FROM assistants WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  ).get() as { slug: string } | undefined;
  const resolveWorkspace = createWorkspaceResolver({
    db: ctx.db,
    dataDir: ctx.config.dataDir,
    sourceDir: ctx.config.sourceDir,
    defaultAssistantSlug: firstAssistant?.slug ?? 'assistant',
  });
  const workspace = resolveWorkspace(conversation).workspaceDir;
  const canonicalWorkspace = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
  const registered = registeredFilePaths(ctx, conversation);
  let totalBytes = 0;
  const resolved: string[] = [];
  for (const input of inputs) {
    const candidate = path.isAbsolute(input) ? input : path.resolve(workspace, input);
    let canonical: string;
    let stat: fs.Stats;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('symlink');
      canonical = fs.realpathSync(candidate);
      stat = fs.statSync(canonical);
    } catch {
      throw new Error(`Attachment is not a readable local file: ${input}`);
    }
    if (!stat.isFile()) throw new Error(`Attachment is not a regular file: ${input}`);
    if (!inside(canonicalWorkspace, canonical) && !registered.has(canonical)) {
      throw new Error(`Attachment is outside this chat's workspace and generated Files: ${input}`);
    }
    if (sensitivePath(canonical)) throw new Error(`Sensitive files cannot be attached: ${input}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error('Attachments exceed the 18 MB draft limit.');
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  return resolved;
}

/** Agent-only local-file bridge. Browser callers cannot submit host paths. */
export function createGmailDraftsRouter(
  ctx: AppContext,
  deps: GmailDraftsRouterDependencies = {},
): Router {
  const router = express.Router();
  const createDraft = deps.createDraft ?? createComposioGmailDraft;
  const updateDraft = deps.updateDraft ?? updateComposioGmailDraft;

  router.post('/drafts-with-attachments', (req: Request, res) => {
    if (!req.agentConversationId) {
      res.status(403).json({ ok: false, error: 'Local Gmail attachments are available only to an authenticated agent chat.' });
      return;
    }
    const parsed = DraftSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid draft.' });
      return;
    }
    const conversation = ctx.db.prepare(
      'SELECT * FROM conversations WHERE id = ?',
    ).get(req.agentConversationId) as ConversationRow | undefined;
    if (!conversation) {
      res.status(404).json({ ok: false, error: 'Authenticated agent conversation not found.' });
      return;
    }

    void (async (): Promise<ComposioGmailDraftResult> => {
      const row = selectGmailRow(eligibleGmailRows(ctx, conversation.id, req.user!.id), parsed.data.account);
      const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
      if (!apiKey) throw new Error('Composio is not configured.');
      const config = JSON.parse(row.config_json) as ComposioInstallConfig;
      if (!config.sessionId) throw new Error('The selected Gmail connection must be reconnected.');
      const attachmentPaths = resolveAttachments(ctx, conversation, parsed.data.attachments);
      const { account: _account, attachments: _attachments, ...draft } = parsed.data;
      return createDraft(apiKey, config.sessionId, { ...draft, attachmentPaths });
    })()
      .then((result) => res.json({
        ok: true,
        draft: {
          attached: parsed.data.attachments.length,
          gmailUrl: result.gmailUrl,
          sent: false,
        },
      }))
      .catch((err) => res.status(400).json({ ok: false, error: composioErrorMessage(err) }));
  });

  router.post('/drafts/update-attachments', (req: Request, res) => {
    if (!req.agentConversationId) {
      res.status(403).json({ ok: false, error: 'Local Gmail attachments are available only to an authenticated agent chat.' });
      return;
    }
    const parsed = DraftUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.');
      res.status(400).json({ ok: false, error: field ? `${field}: ${issue?.message}` : 'Invalid draft update.' });
      return;
    }
    const conversation = ctx.db.prepare(
      'SELECT * FROM conversations WHERE id = ?',
    ).get(req.agentConversationId) as ConversationRow | undefined;
    if (!conversation) {
      res.status(404).json({ ok: false, error: 'Authenticated agent conversation not found.' });
      return;
    }

    void (async () => {
      const rows = eligibleGmailRows(ctx, conversation.id, req.user!.id, ['GMAIL_GET_DRAFT', 'GMAIL_UPDATE_DRAFT']);
      const row = selectGmailRow(rows, parsed.data.account);
      const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
      if (!apiKey) throw new Error('Composio is not configured.');
      const config = JSON.parse(row.config_json) as ComposioInstallConfig;
      if (!config.sessionId) throw new Error('The selected Gmail connection must be reconnected.');
      const attachmentPaths = resolveAttachments(ctx, conversation, parsed.data.attachments);
      const {
        account: _account, attachments: _attachments, draft_id: draftId, thread_id: threadId, ...draft
      } = parsed.data;
      const result = await updateDraft(apiKey, config.sessionId, {
        ...draft, attachmentPaths, draftId, ...(threadId ? { threadId } : {}),
      });
      return { result, attached: attachmentPaths.length };
    })()
      .then(({ result, attached }) => res.json({
        ok: true,
        draft: {
          updated: true,
          draft_id: result.draftId,
          thread_id: result.threadId,
          attached,
          gmailUrl: result.gmailUrl,
          sent: false,
        },
      }))
      .catch((err) => res.status(400).json({ ok: false, error: composioErrorMessage(err) }));
  });

  return router;
}
