import type Database from 'better-sqlite3';
import { z } from 'zod';

/**
 * Client brand defaults edited in Settings → Appearance. They guide published
 * pages/apps and, when applyToApp is enabled, subtly theme the Veneer Pro UI.
 * Stored as a single settings-KV row under `page_brand` (settings: key TEXT
 * PRIMARY KEY, value_json TEXT). Empty strings mean "unset"; when nothing
 * meaningful is set the agent's page styling falls back to Veneer's own house
 * look (see the appearance guidance in toolbox/materialize.ts).
 */

export const PAGE_BRAND_KEY = 'page_brand';

// A color is either empty (unset) or a #rgb / #rrggbb hex string.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const colorField = z
  .string()
  .trim()
  .refine((v) => v === '' || HEX_COLOR.test(v), 'Must be a hex color like #8a6d47')
  .optional();

export const PageBrandSchema = z.object({
  primaryColor: colorField,
  accentColor: colorField,
  backgroundColor: colorField,
  // `font` is the body typeface. The name predates headings having their own
  // setting, so it stays as-is: existing instances already have it stored.
  font: z.string().trim().max(120).optional(),
  headingFont: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(600).optional(),
  applyToApp: z.boolean().optional(),
});

export type PageBrand = z.infer<typeof PageBrandSchema>;

/** All-empty brand — the GET default and the "unset" shape. */
export const EMPTY_BRAND: Required<PageBrand> = {
  primaryColor: '',
  accentColor: '',
  backgroundColor: '',
  font: '',
  headingFont: '',
  notes: '',
  applyToApp: true,
};

/**
 * Read the stored brand, or null when nothing meaningful is set (every field
 * empty or absent). Cheap single-row read; callers do not cache.
 */
export function readPageBrand(db: Database.Database): PageBrand | null {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(PAGE_BRAND_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  let parsed: PageBrand;
  try {
    const result = PageBrandSchema.safeParse(JSON.parse(row.value_json));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const hasAny = Object.values(parsed).some((v) => typeof v === 'string' && v.trim() !== '');
  return hasAny ? { ...parsed, applyToApp: parsed.applyToApp ?? true } : null;
}

/** Persist the normalized full brand shape. */
export function writePageBrand(db: Database.Database, brand: Required<PageBrand>): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(PAGE_BRAND_KEY, JSON.stringify(brand));
}
