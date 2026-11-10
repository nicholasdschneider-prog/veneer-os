import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppContext } from '../context.js';
import { sameBusiness } from '../conversations/access.js';
import { BotError, createBotService, type Actor, type Proposal } from './service.js';

const MAX_BYTES = 20 * 1024 * 1024;
type Image = NonNullable<Proposal['images']>[number];
const unavailable = () => new BotError(404, 'Image unavailable. Ask the bot to attach the retained original to this proposal.');

/** Only passive raster formats; neither extension nor a supplied MIME is trusted. */
export function rasterType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** PDF alongside the passive rasters, for document evidence. */
export function documentType(bytes: Buffer): string | null {
  return rasterType(bytes) ?? (bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : null);
}

/** Read a file the bot conversation is known to hold, with the same exact-membership and ACL rules as decision images. */
export async function loadConversationFile(ctx: AppContext, actor: Actor, botId: string, ref: { conversation_id: string; path: string }, accept: (bytes: Buffer) => string | null) {
  return load(ctx, actor, botId, ref, accept);
}

/**
 * A bot's task chats and coordination lanes are side chats of its main chat and
 * share its access; a file one of them retained (registered to that exact chat)
 * may be cited through any chat of the same family. Still an exact registry
 * row, never a directory or guessed-path grant.
 */
function heldByFamily(ctx: AppContext, source: { id: string; side_chat_of?: string | null }, file: string) {
  const root = source.side_chat_of ?? source.id;
  return ctx.db.prepare(`SELECT 1 FROM generated_files g JOIN conversations c ON c.id = g.conversation_id
    WHERE g.path = ? AND (c.id = ? OR c.side_chat_of = ?)`).get(file, root, root);
}

async function load(ctx: AppContext, actor: Actor, botId: string, image: { conversation_id: string; path: string }, accept: (bytes: Buffer) => string | null = rasterType) {
  const service = createBotService(ctx.db);
  let source;
  try { source = service.chat(actor, image.conversation_id); }
  catch (e) {
    if (e instanceof BotError && e.status === 404) throw new BotError(404, `source.conversation_id ${image.conversation_id.slice(0, 80)} is not a chat this bot can cite. For a file in your own chat use this chat's id ${botId}.`);
    throw e;
  }
  if (!sameBusiness(ctx.db, botId, source)) throw unavailable();
  // Exact registered/session membership, never a root-directory or guessed-path grant.
  if (!path.isAbsolute(image.path) || image.path.includes('\0')) throw unavailable();
  const registered = ctx.db.prepare('SELECT 1 FROM generated_files WHERE conversation_id=? AND path=?').get(source.id, image.path)
    ?? heldByFamily(ctx, source, image.path);
  if (!registered) {
    const refs = await ctx.manager.listSessionFiles(source.id);
    const ref = refs.find(r => r.path === image.path);
    if (!ref) throw unavailable();
    if (ref.source === 'bash') {
      try {
        if (fs.statSync(image.path).mtimeMs < Date.parse(`${source.created_at.replace(' ', 'T')}Z`)) throw unavailable();
      } catch { throw unavailable(); }
    }
  }
  // Recheck ACL after the async scan. Do not follow a swapped symlink at open.
  service.chat(actor, botId);
  service.chat(actor, source.id);
  let fd: number | undefined;
  try {
    if (fs.realpathSync(image.path) !== image.path) throw unavailable();
    fd = fs.openSync(image.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 12) throw unavailable();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw unavailable();
      offset += count;
    }
    const type = accept(bytes);
    if (!type) throw unavailable();
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { bytes, type, sha256 };
  } catch { throw unavailable(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Bind actual bytes before creating a new proposal version. Never silently rebind an old hash. */
export async function bindDecisionImages(ctx: AppContext, actor: Actor, botId: string, proposal: Proposal): Promise<Proposal> {
  createBotService(ctx.db).chat(actor, botId);
  if (!proposal.images?.length) return proposal;
  const images: Image[] = [];
  for (const [index, image] of proposal.images.entries()) {
    const found = await load(ctx, actor, botId, image).catch((e: unknown) => {
      // Name the failing reference so the bot can fix that one file, not guess.
      if (e instanceof BotError && e.status === 404) throw new BotError(404, `images[${index}] (${image.label}): ${e.message}`);
      throw e;
    });
    if (image.sha256 && image.sha256 !== found.sha256) throw new BotError(409, 'Image changed. Review the new evidence and revise the proposal with its new image reference.');
    images.push({ ...image, sha256: found.sha256 });
  }
  return { ...proposal, images };
}

export async function readDecisionImage(ctx: AppContext, actor: Actor, id: string, version: number, index: number) {
  const s = createBotService(ctx.db);
  const decision = s.read(actor, id);
  if (decision.version !== version) throw new BotError(409, 'Proposal changed. Reload the decision.');
  const image = (JSON.parse(decision.proposal_json) as Proposal).images?.[index];
  if (!image?.sha256) throw unavailable();
  const found = await load(ctx, actor, decision.conversation_id, image);
  const current = s.read(actor, id);
  if (current.version !== version || found.sha256 !== image.sha256) throw new BotError(409, 'Image or proposal changed. Ask the bot to update the evidence.');
  return found;
}
