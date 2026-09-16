import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ProjectAppearance } from '../projects/appearance.js';

/**
 * Custom font library (see 0067_page_fonts.sql). Owners upload licensed font
 * files in Settings → Appearance; the bytes go to the pages R2 bucket under
 * `f/<id>/<file>` and are served from the same public base as pages, so a
 * published page loads them same-origin with no CORS setup.
 *
 * A font is identified by its CSS family name. When the brand's heading/body
 * font matches an uploaded family, agents receive a ready-made `@font-face`
 * block; otherwise the family is treated as a Google Fonts name, exactly as
 * before this feature existed.
 */

/** Accepted upload types, mapped to the CSS `format()` hint. */
export const FONT_FORMATS: Record<string, { format: string; contentType: string }> = {
  woff2: { format: 'woff2', contentType: 'font/woff2' },
  woff: { format: 'woff', contentType: 'font/woff' },
  ttf: { format: 'truetype', contentType: 'font/ttf' },
  otf: { format: 'opentype', contentType: 'font/otf' },
};

export const FONT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB — ample for one weight.

export const FontUploadSchema = z.object({
  family: z.string().trim().min(1).max(80),
  weight: z
    .string()
    .trim()
    .regex(/^(?:[1-9]00|normal|bold)$/, 'Weight must be 100–900, normal, or bold')
    .default('400'),
  style: z.enum(['normal', 'italic']).default('normal'),
  fileName: z.string().trim().min(1).max(120),
});

export type FontUpload = z.infer<typeof FontUploadSchema>;

export interface CustomFont {
  id: string;
  family: string;
  weight: string;
  style: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  objectKey: string;
  publicUrl: string;
  createdAt: string;
}

interface FontRow {
  id: string;
  family: string;
  weight: string;
  style: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  object_key: string;
  public_url: string;
  created_at: string;
}

function toFont(row: FontRow): CustomFont {
  return {
    id: row.id,
    family: row.family,
    weight: row.weight,
    style: row.style,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    objectKey: row.object_key,
    publicUrl: row.public_url,
    createdAt: row.created_at,
  };
}

/**
 * The upload's file extension, lowercased, or null when it is not a font type
 * we accept. Used both to validate the upload and to pick the CSS format hint.
 */
export function fontExtension(fileName: string): string | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return ext in FONT_FORMATS ? ext : null;
}

/** A filesystem- and URL-safe object name derived from the uploaded file name. */
export function safeFileName(fileName: string): string {
  const ext = fontExtension(fileName) ?? 'woff2';
  const base = fileName
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Collapse dot runs so no `..` segment survives into the object key/URL.
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `${base || 'font'}.${ext}`;
}

/**
 * Cheap magic-number check so a renamed .zip or an HTML error page cannot be
 * stored as a font. Mirrors the PNG sniff on the client-logo upload.
 */
export function looksLikeFont(bytes: Uint8Array, ext: string): boolean {
  if (bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  switch (ext) {
    case 'woff2':
      return tag === 'wOF2';
    case 'woff':
      return tag === 'wOFF';
    case 'otf':
      return tag === 'OTTO';
    case 'ttf':
      // TrueType is either the 0x00010000 version tag or the legacy 'true'.
      return (
        tag === 'true' ||
        (bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00)
      );
    default:
      return false;
  }
}

export function listFonts(db: Database.Database): CustomFont[] {
  const rows = db
    .prepare('SELECT * FROM page_fonts ORDER BY family COLLATE NOCASE, weight, style')
    .all() as FontRow[];
  return rows.map(toFont);
}

export function getFont(db: Database.Database, id: string): CustomFont | null {
  const row = db.prepare('SELECT * FROM page_fonts WHERE id = ?').get(id) as FontRow | undefined;
  return row ? toFont(row) : null;
}

export function insertFont(
  db: Database.Database,
  font: Omit<CustomFont, 'createdAt'>,
): CustomFont {
  db.prepare(
    `INSERT INTO page_fonts (id, family, weight, style, file_name, content_type, size_bytes, object_key, public_url)
     VALUES (@id, @family, @weight, @style, @fileName, @contentType, @sizeBytes, @objectKey, @publicUrl)`,
  ).run(font);
  return getFont(db, font.id)!;
}

export function deleteFont(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM page_fonts WHERE id = ?').run(id);
}

export function newFontId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** R2 key for a font file. Outside `p/`, so the page-expiry rule ignores it. */
export function fontObjectKey(id: string, fileName: string): string {
  return `f/${id}/${fileName}`;
}

/** Every uploaded file for one family, matched case-insensitively. */
export function fontsForFamily(fonts: CustomFont[], family: string): CustomFont[] {
  const wanted = family.trim().toLowerCase();
  if (!wanted) return [];
  return fonts.filter((font) => font.family.trim().toLowerCase() === wanted);
}

/**
 * The `@font-face` rules for the given files, ready to paste into a page's
 * <style>. `font-display: swap` keeps text readable while the file loads.
 */
export function fontFaceCss(fonts: CustomFont[]): string {
  return fonts
    .map((font) => {
      const ext = fontExtension(font.fileName) ?? 'woff2';
      const format = FONT_FORMATS[ext]?.format ?? 'woff2';
      return [
        '@font-face {',
        `  font-family: ${JSON.stringify(font.family)};`,
        `  src: url(${JSON.stringify(font.publicUrl)}) format(${JSON.stringify(format)});`,
        `  font-weight: ${font.weight};`,
        `  font-style: ${font.style};`,
        '  font-display: swap;',
        '}',
      ].join('\n');
    })
    .join('\n');
}

/**
 * Copy-ready font setup returned only by the project_settings tool for page or
 * app work. It is not part of a chat's durable instruction snapshot.
 */
export function typographyGuidance(
  db: Database.Database,
  appearance: Required<ProjectAppearance>,
): string | null {
  const roles = [
    { role: 'Headings', family: appearance.headingFont.trim() },
    { role: 'Body text', family: appearance.font.trim() },
  ].filter((entry) => entry.family !== '');
  if (roles.length === 0) return null;

  const library = listFonts(db);
  const faces = new Map<string, CustomFont>();
  const google: string[] = [];
  const lines: string[] = [];
  for (const { role, family } of roles) {
    const hosted = fontsForFamily(library, family);
    if (hosted.length > 0) {
      for (const font of hosted) faces.set(font.id, font);
      lines.push(`- ${role}: ${JSON.stringify(family)} — a custom font this instance hosts.`);
    } else {
      if (!google.includes(family)) google.push(family);
      lines.push(`- ${role}: ${JSON.stringify(family)} — a Google Fonts family.`);
    }
  }

  const parts = ['Typography for this page or app:', ...lines];
  if (google.length > 0) {
    const families = google
      .map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600;700`)
      .join('&');
    parts.push(
      `Load the Google families with exactly this tag: <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families}&display=swap">`,
    );
  }
  if (faces.size > 0) {
    parts.push(
      'Load the custom font by copying this CSS into the page\'s <style> exactly as written. The URLs are already public:',
      fontFaceCss([...faces.values()]),
    );
  }
  parts.push(
    'Always keep a fallback in the stack, for example font-family: "Name", ui-sans-serif, system-ui, sans-serif.',
  );
  return parts.join('\n');
}
