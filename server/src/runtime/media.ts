import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Content-addressed store for images that arrive inside tool_result blocks
 * (screenshots from browser tools, Read on an image file, MCP tools, …).
 * Bytes land in <dataDir>/media/<sha256-prefix>.<ext>; events carry only the
 * id, and the client fetches GET /api/media/:id. Content addressing means the
 * live-stream path and the JSONL-rehydration path independently produce the
 * same id for the same image, so refs stay stable across reloads and nothing
 * is ever written twice.
 *
 * Module-level singleton (initialized once at boot) so the claude adapter and
 * the transcript parser — a sync, pure-ish function — can both save without
 * threading a store handle through every call site. Uninitialized (unit
 * tests), saves are a no-op returning no ids.
 */

let mediaDir: string | null = null;

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MEDIA_ID_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

export function initMediaStore(dataDir: string): void {
  mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
}

/** Test seam: point the store at a temp dir, or null to disable. */
export function _setMediaDirForTest(dir: string | null): void {
  mediaDir = dir;
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

/** Persist raw image bytes and return their stable media-store id. */
export function saveImageBytes(data: Uint8Array, mediaType: string): string | null {
  if (!mediaDir) return null;
  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) return null;
  const bytes = Buffer.from(data);
  if (!bytes.length) return null;
  const id = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
  const file = path.join(mediaDir, id);
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  } catch {
    return null; // disk trouble must never derail a turn
  }
  return id;
}

function saveImageBase64(data: string, mediaType: string): string | null {
  return saveImageBytes(Buffer.from(data, 'base64'), mediaType);
}

/**
 * Walk a tool_result `content` value (string | block array) and persist every
 * base64 image block. Returns the media ids in order of appearance.
 */
export function saveToolResultImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } };
    if (b.type !== 'image' || b.source?.type !== 'base64') continue;
    if (typeof b.source.data !== 'string' || typeof b.source.media_type !== 'string') continue;
    const id = saveImageBase64(b.source.data, b.source.media_type);
    if (id) ids.push(id);
  }
  return ids;
}

/** Resolve a media id to its on-disk path; null if malformed (or store off). */
export function mediaFilePath(id: string): string | null {
  if (!mediaDir || !MEDIA_ID_RE.test(id)) return null;
  return path.join(mediaDir, id);
}
