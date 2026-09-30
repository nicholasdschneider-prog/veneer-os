import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import type { UserConnectorRow } from '../db/db.js';
import { connectedConnectorRowsForConversation } from '../connectors/access.js';
import { connectorDef } from '../connectors/catalog.js';
import { connectorAccessModeProfile } from '../connectors/accessModes.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import { documentType, loadConversationFile, rasterType } from './decisionImages.js';
import { BotError, createBotService, type Actor, type EvidenceItem, type Proposal } from './service.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_EXCERPT = 2000;

/**
 * Fetchers for source systems. Injected so tests never reach the network and so
 * a missing integration fails with a precise message instead of a guess.
 */
export interface EvidenceFetchers {
  gmailMessage?: (session: { apiKey: string; sessionId: string }, messageId: string) => Promise<{ from: string; to: string; date: string; subject: string; text: string }>;
  gmailAttachment?: (session: { apiKey: string; sessionId: string }, messageId: string, attachmentId: string, filename?: string) => Promise<Buffer>;
  /** OrderOps ticket attachment bytes. Absent until OrderOps exposes a custody-scoped read. */
  orderopsAttachment?: (ticketId: string, attachmentId: string) => Promise<Buffer>;
}

export const ORDEROPS_ATTACHMENT_UNAVAILABLE = 'OrderOps attachment reads are not available yet: OrderOps has no custody-scoped endpoint that returns ticket attachment bytes to Veneer (requested from the OrderOps Runtime Custodian). Until then, retain the photo through your own OrderOps or Gmail access as a chat file and cite it with source.system chat_file, or cite the Gmail attachment directly.';

/** Content-addressed retention under DATA_DIR; the proposal keeps only the hash. */
function blobDir(ctx: AppContext) { return path.join(ctx.config.dataDir, 'decision-evidence'); }
function blobPath(ctx: AppContext, sha256: string) { return path.join(blobDir(ctx), sha256.slice(0, 2), sha256); }
export function retainEvidenceBytes(ctx: AppContext, bytes: Buffer, type: string): string {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const target = blobPath(ctx, sha256);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.writeFileSync(`${tmp}.type`, type, { mode: 0o600 });
    fs.renameSync(`${tmp}.type`, `${target}.type`);
    fs.renameSync(tmp, target);
  }
  return sha256;
}
export function readEvidenceBytes(ctx: AppContext, sha256: string): { bytes: Buffer; type: string } | null {
  const target = blobPath(ctx, sha256);
  try {
    const bytes = fs.readFileSync(target);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
    return { bytes, type: fs.readFileSync(`${target}.type`, 'utf8').trim() || 'application/octet-stream' };
  } catch { return null; }
}

function acceptFor(kind: EvidenceItem['kind']) {
  return kind === 'image' ? rasterType : documentType;
}

/** A file the human uploaded from the composer: must live under DATA_DIR/uploads, be a regular file, and be an image or PDF. */
export function loadUploadedFile(ctx: AppContext, filePath: string, kind: EvidenceItem['kind']): { bytes: Buffer; type: string } {
  const uploads = path.join(ctx.config.dataDir, 'uploads');
  const unavailable = () => new BotError(404, 'Uploaded file unavailable. Attach it again from the composer.');
  if (!path.isAbsolute(filePath) || filePath.includes('\0')) throw unavailable();
  const relative = path.relative(uploads, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw unavailable();
  let fd: number | undefined;
  try {
    if (fs.realpathSync(filePath) !== filePath) throw unavailable();
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 12) throw unavailable();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw unavailable(); offset += n; }
    const type = acceptFor(kind)(bytes);
    if (!type) throw new BotError(400, 'Only PNG, JPEG, GIF, WebP images and PDF documents can be attached as evidence.');
    return { bytes, type };
  } catch (err) { if (err instanceof BotError) throw err; throw unavailable(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function gmailSession(ctx: AppContext, botId: string, actorUserId: number, account: string | undefined, slug: string): { apiKey: string; sessionId: string } {
  const def = connectorDef('gmail');
  const rows = connectedConnectorRowsForConversation(ctx.db, botId, actorUserId).filter((row: UserConnectorRow) => {
    if (row.connector_slug !== 'gmail') return false;
    const profile = connectorAccessModeProfile(def?.accessModes, row.access_mode, row.access_version);
    return profile?.composio?.toolSlugs.includes(slug) ?? false;
  });
  const wanted = account?.trim().toLowerCase();
  const row = wanted ? rows.find((r) => r.label?.trim().toLowerCase() === wanted) : rows.length === 1 ? rows[0] : undefined;
  if (!row) throw new BotError(409, wanted ? `No Gmail connection named "${account}" with read access is available to this bot.` : rows.length ? `More than one Gmail connection is available; set source.account to one of: ${rows.map((r) => r.label || 'Unlabeled').join(', ')}.` : 'This bot has no Gmail connection with read access, so Gmail evidence cannot be fetched.');
  const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
  const sessionId = (JSON.parse(row.config_json || '{}') as { sessionId?: string }).sessionId;
  if (!apiKey || !sessionId) throw new BotError(409, 'The Gmail connection is not fully configured (missing Composio session).');
  return { apiKey, sessionId };
}

function excerpt(text: string) { return text.replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT); }

/**
 * Bind every evidence item before a new proposal version is stored: fetch and
 * retain files, fill excerpts, set hashes. A cited item that cannot be fetched
 * fails the raise with the exact reason; a description never stands in for it.
 */
export async function bindDecisionEvidence(ctx: AppContext, actor: Actor, botId: string, proposal: Proposal, fetchers: EvidenceFetchers = {}): Promise<Proposal> {
  createBotService(ctx.db).chat(actor, botId);
  const items = proposal.evidence_items;
  if (!items?.length) return proposal;
  const bound: EvidenceItem[] = [];
  const now = new Date().toISOString();
  for (const [index, item] of items.entries()) {
    const label = `evidence_items[${index}] (${item.label})`;
    const src = item.source;
    const retain = (bytes: Buffer, type: string) => {
      const sha256 = retainEvidenceBytes(ctx, bytes, type);
      if (item.sha256 && item.sha256 !== sha256) throw new BotError(409, `${label}: the file changed since it was cited. Review the new bytes and revise with the new hash.`);
      return { ...item, sha256, retained: true, captured_at: item.captured_at ?? now, added_by: item.added_by ?? 'bot' as const };
    };
    if (item.kind === 'image' || item.kind === 'document') {
      if (src.system === 'chat_file') {
        const found = await loadConversationFile(ctx, actor, botId, src, acceptFor(item.kind));
        bound.push(retain(found.bytes, found.type));
      } else if (src.system === 'upload') {
        if (item.added_by !== 'human') throw new BotError(400, `${label}: bots cite chat files, not composer uploads.`);
        const found = loadUploadedFile(ctx, src.path, item.kind);
        bound.push(retain(found.bytes, found.type));
      } else if (src.system === 'gmail') {
        if (!src.attachment_id) throw new BotError(400, `${label}: a Gmail file needs source.attachment_id (from GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID).`);
        if (!fetchers.gmailAttachment) throw new BotError(409, `${label}: Gmail attachment fetch is not configured on this server.`);
        const bytes = await fetchers.gmailAttachment(gmailSession(ctx, botId, actor.user.id, src.account, 'GMAIL_GET_ATTACHMENT'), src.message_id, src.attachment_id, src.filename);
        const type = acceptFor(item.kind)(bytes);
        if (!type) throw new BotError(400, `${label}: the Gmail attachment is not a supported image or PDF.`);
        bound.push(retain(bytes, type));
      } else if (src.system === 'orderops') {
        if (!src.attachment_id) throw new BotError(400, `${label}: an OrderOps file needs source.attachment_id.`);
        if (!fetchers.orderopsAttachment) throw new BotError(409, `${label}: ${ORDEROPS_ATTACHMENT_UNAVAILABLE}`);
        const bytes = await fetchers.orderopsAttachment(src.ticket_id, src.attachment_id);
        const type = acceptFor(item.kind)(bytes);
        if (!type) throw new BotError(400, `${label}: the OrderOps attachment is not a supported image or PDF.`);
        bound.push(retain(bytes, type));
      } else {
        throw new BotError(400, `${label}: a ${item.kind} cannot come from ${src.system}; cite the file from gmail, orderops or a chat file.`);
      }
    } else if (item.kind === 'message') {
      if (src.system === 'gmail') {
        if (!fetchers.gmailMessage) throw new BotError(409, `${label}: Gmail message fetch is not configured on this server.`);
        const m = await fetchers.gmailMessage(gmailSession(ctx, botId, actor.user.id, src.account, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'), src.message_id);
        const text = excerpt(`${m.from} → ${m.to} · ${m.date} · ${m.subject}\n${m.text}`);
        bound.push({ ...item, text, sha256: crypto.createHash('sha256').update(text).digest('hex'), retained: false, captured_at: item.captured_at ?? now, added_by: item.added_by ?? 'bot' });
      } else if (src.system === 'orderops') {
        if (!item.text?.trim()) throw new BotError(400, `${label}: quote the OrderOps message in text (sender, time, channel, wording) and cite its message_id.`);
        bound.push({ ...item, text: excerpt(item.text), retained: false, captured_at: item.captured_at ?? now, added_by: item.added_by ?? 'bot' });
      } else {
        throw new BotError(400, `${label}: a message excerpt must come from gmail or orderops.`);
      }
    } else {
      // record: the bot's own read of order/refund/ticket facts, cited by exact ids.
      if (src.system !== 'shopify' && src.system !== 'orderops') throw new BotError(400, `${label}: record facts must cite shopify or orderops ids.`);
      if (!item.text?.trim()) throw new BotError(400, `${label}: put the facts you read in text (for example order, refund ids, amounts, dates, status) so the human sees them on the card.`);
      bound.push({ ...item, text: excerpt(item.text), retained: false, captured_at: item.captured_at ?? now, added_by: item.added_by ?? 'bot' });
    }
  }
  const hashes = [...new Set([...(proposal.images ?? []).map((i) => i.sha256).filter((h): h is string => !!h), ...bound.map((b) => b.sha256).filter((h): h is string => !!h)])];
  const as_of = proposal.as_of ? { ...proposal.as_of, evidence_hashes: hashes } : { captured_at: now, last_inbound: [], evidence_hashes: hashes };
  return { ...proposal, evidence_items: bound, as_of };
}

/** Serve one retained evidence file of a decision version to a viewer allowed to read the decision. */
export function readDecisionEvidence(ctx: AppContext, actor: Actor, id: string, version: number, index: number): { bytes: Buffer; type: string; item: EvidenceItem } {
  const s = createBotService(ctx.db);
  const decision = s.read(actor, id);
  if (decision.version !== version) throw new BotError(409, 'Proposal changed. Reload the decision.');
  const proposal = JSON.parse(decision.proposal_json) as Proposal;
  const human = ctx.db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='evidence_added' ORDER BY rowid").all(id, version).map((r) => JSON.parse((r as { payload_json: string }).payload_json) as EvidenceItem);
  const all = [...(proposal.evidence_items ?? []), ...human];
  const item = all[index];
  if (!item?.sha256 || !item.retained) throw new BotError(404, 'Evidence file unavailable.');
  // A chat file stays gated on the source conversation, as decision images are.
  if (item.source.system === 'chat_file') s.chat(actor, item.source.conversation_id);
  const found = readEvidenceBytes(ctx, item.sha256);
  if (!found) throw new BotError(404, 'Evidence file unavailable.');
  return { ...found, item };
}

/** A human attaches an uploaded file to a question; retained and hashed like bot evidence. */
export function bindHumanEvidence(ctx: AppContext, upload: { path: string; label: string }): EvidenceItem {
  const probe = loadUploadedFile(ctx, upload.path, 'document');
  const kind: EvidenceItem['kind'] = rasterType(probe.bytes) ? 'image' : 'document';
  const sha256 = retainEvidenceBytes(ctx, probe.bytes, probe.type);
  return { kind, label: upload.label, source: { system: 'upload', path: upload.path }, sha256, retained: true, captured_at: new Date().toISOString(), added_by: 'human' };
}

/** Default Composio-backed Gmail fetchers. Composio returns file tool outputs as a downloadable object or inline base64. */
export function composioGmailFetchers(): EvidenceFetchers {
  async function execute(session: { apiKey: string; sessionId: string }, slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { Composio } = await import('@composio/core');
    const composio = new Composio({ apiKey: session.apiKey, allowTracking: false });
    const s = await composio.sessions.use(session.sessionId);
    const result = await s.execute(slug, args);
    if (result.error) throw new BotError(409, typeof result.error === 'string' ? result.error : `${slug} failed`);
    return (result.data ?? {}) as Record<string, unknown>;
  }
  const str = (v: unknown) => typeof v === 'string' ? v : '';
  return {
    async gmailMessage(session, messageId) {
      const data = await execute(session, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: messageId, user_id: 'me', format: 'full' });
      const headers = (Array.isArray((data.payload as { headers?: unknown[] } | undefined)?.headers) ? ((data.payload as { headers: { name: string; value: string }[] }).headers) : []);
      const h = (name: string) => headers.find((x) => x.name?.toLowerCase() === name)?.value ?? str(data[name]);
      return { from: h('from') || str(data.sender), to: h('to'), date: h('date') || str(data.messageTimestamp), subject: h('subject') || str(data.subject), text: str(data.messageText) || str(data.snippet) };
    },
    async gmailAttachment(session, messageId, attachmentId, filename) {
      const data = await execute(session, 'GMAIL_GET_ATTACHMENT', { message_id: messageId, attachment_id: attachmentId, file_name: filename ?? 'attachment', user_id: 'me' });
      const file = (data.file ?? data.attachment ?? data) as Record<string, unknown>;
      const inline = str(file.data) || str(file.content) || str(data.data);
      if (inline) return Buffer.from(inline.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const url = str(file.s3url) || str(file.s3_url) || str(file.uri) || str(file.url);
      if (!/^https:\/\//.test(url)) throw new BotError(409, 'Gmail attachment fetch returned no downloadable file.');
      const res = await fetch(url, { redirect: 'error' });
      if (!res.ok) throw new BotError(409, `Gmail attachment download failed (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new BotError(400, 'Gmail attachment exceeds 20 MB.');
      return bytes;
    },
  };
}
