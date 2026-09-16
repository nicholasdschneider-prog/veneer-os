import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { EMPTY_BRAND, PAGE_BRAND_KEY, PageBrandSchema, readPageBrand } from '../src/pages/brand.js';
import {
  deleteFont,
  fontExtension,
  fontFaceCss,
  fontObjectKey,
  fontsForFamily,
  insertFont,
  listFonts,
  looksLikeFont,
  safeFileName,
  typographyGuidance,
  type CustomFont,
} from '../src/pages/fonts.js';
import { putObject } from '../src/pages/r2.js';
import { VENEER_HOUSE_APPEARANCE } from '../src/projects/appearance.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function fontBytes(tag: string): Buffer {
  return Buffer.concat([Buffer.from(tag, 'ascii'), Buffer.alloc(64)]);
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function addFont(patch: Partial<Omit<CustomFont, 'createdAt'>> = {}): CustomFont {
  return insertFont(db, {
    id: patch.id ?? 'f1',
    family: patch.family ?? 'Harman Sans',
    weight: patch.weight ?? '400',
    style: patch.style ?? 'normal',
    fileName: patch.fileName ?? 'Harman-Sans.woff2',
    contentType: patch.contentType ?? 'font/woff2',
    sizeBytes: patch.sizeBytes ?? 28628,
    objectKey: patch.objectKey ?? 'f/f1/Harman-Sans.woff2',
    publicUrl: patch.publicUrl ?? 'https://veneer.page/f/f1/Harman-Sans.woff2',
  });
}

describe('font file validation', () => {
  it('accepts only web font extensions', () => {
    expect(fontExtension('Harman-Sans.woff2')).toBe('woff2');
    expect(fontExtension('Harman-Sans.WOFF')).toBe('woff');
    expect(fontExtension('a.ttf')).toBe('ttf');
    expect(fontExtension('a.otf')).toBe('otf');
    expect(fontExtension('payload.svg')).toBeNull();
    expect(fontExtension('noextension')).toBeNull();
  });

  it('sanitizes the stored file name and keeps the extension', () => {
    expect(safeFileName('Harman Sans/../../etc.woff2')).toBe('Harman-Sans-.-.-etc.woff2');
    expect(safeFileName('  .woff2')).toBe('font.woff2');
    expect(safeFileName('name.with.dots.woff')).toBe('name.with.dots.woff');
  });

  it('rejects bytes whose magic number does not match the extension', () => {
    expect(looksLikeFont(fontBytes('wOF2'), 'woff2')).toBe(true);
    expect(looksLikeFont(fontBytes('wOFF'), 'woff')).toBe(true);
    expect(looksLikeFont(fontBytes('OTTO'), 'otf')).toBe(true);
    expect(looksLikeFont(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]), 'ttf')).toBe(true);
    // A renamed zip, and a font uploaded under the wrong extension.
    expect(looksLikeFont(fontBytes('PK'), 'woff2')).toBe(false);
    expect(looksLikeFont(fontBytes('wOFF'), 'woff2')).toBe(false);
    expect(looksLikeFont(Buffer.alloc(2), 'woff2')).toBe(false);
  });
});

describe('font library storage', () => {
  it('stores fonts outside the expiring p/ prefix', () => {
    expect(fontObjectKey('abc123', 'Harman-Sans.woff2')).toBe('f/abc123/Harman-Sans.woff2');
    expect(fontObjectKey('abc123', 'x.woff2').startsWith('p/')).toBe(false);
  });

  it('round-trips through the database and deletes cleanly', () => {
    expect(listFonts(db)).toEqual([]);
    const font = addFont();
    expect(font.family).toBe('Harman Sans');
    expect(font.createdAt).toBeTruthy();
    expect(listFonts(db)).toHaveLength(1);
    deleteFont(db, font.id);
    expect(listFonts(db)).toEqual([]);
  });

  it('matches a family case-insensitively and ignores others', () => {
    addFont();
    addFont({ id: 'f2', family: 'Other', objectKey: 'f/f2/other.woff2' });
    const fonts = listFonts(db);
    expect(fontsForFamily(fonts, 'harman sans').map((f) => f.id)).toEqual(['f1']);
    expect(fontsForFamily(fonts, 'Assistant')).toEqual([]);
    expect(fontsForFamily(fonts, '   ')).toEqual([]);
  });

  it('builds a usable @font-face block', () => {
    const css = fontFaceCss([addFont()]);
    expect(css).toContain('font-family: "Harman Sans";');
    expect(css).toContain('url("https://veneer.page/f/f1/Harman-Sans.woff2") format("woff2")');
    expect(css).toContain('font-weight: 400;');
    expect(css).toContain('font-display: swap;');
  });
});

describe('brand backward compatibility', () => {
  it('keeps reading a brand saved before heading fonts existed', () => {
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      PAGE_BRAND_KEY,
      JSON.stringify({
        primaryColor: '#26221c',
        accentColor: '#8a6d47',
        backgroundColor: '#faf7f2',
        font: 'Inter',
        notes: 'Keep it calm.',
        applyToApp: true,
      }),
    );
    const brand = readPageBrand(db);
    expect(brand?.font).toBe('Inter');
    expect(brand?.headingFont).toBeUndefined();
    expect({ ...EMPTY_BRAND, ...brand }.headingFont).toBe('');
  });

  it('accepts and preserves a heading font', () => {
    const parsed = PageBrandSchema.safeParse({ font: 'Assistant', headingFont: 'Harman Sans' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.headingFont).toBe('Harman Sans');
  });
});

describe('typography guidance for agents', () => {
  const appearance = (patch: Record<string, string>) => ({
    ...VENEER_HOUSE_APPEARANCE,
    headingFont: '',
    ...patch,
  });

  it('is silent when no family is set', () => {
    expect(typographyGuidance(db, appearance({ font: '', headingFont: '' }))).toBeNull();
  });

  it('emits a Google Fonts link for families that are not uploaded', () => {
    const text = typographyGuidance(db, appearance({ font: 'Assistant', headingFont: '' }))!;
    expect(text).toContain('Body text: "Assistant" — a Google Fonts family.');
    expect(text).toContain('https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700');
    expect(text).not.toContain('@font-face');
  });

  it('emits @font-face for an uploaded family and a link for the Google one', () => {
    addFont();
    const text = typographyGuidance(db, appearance({ font: 'Assistant', headingFont: 'Harman Sans' }))!;
    expect(text).toContain('Headings: "Harman Sans" — a custom font this instance hosts.');
    expect(text).toContain('Body text: "Assistant" — a Google Fonts family.');
    expect(text).toContain('@font-face');
    expect(text).toContain('https://veneer.page/f/f1/Harman-Sans.woff2');
    expect(text).toContain('family=Assistant:wght@400;600;700');
    // The uploaded family must not also be requested from Google.
    expect(text).not.toContain('family=Harman+Sans');
  });

  it('escapes a multi-word Google family in the stylesheet URL', () => {
    const text = typographyGuidance(db, appearance({ font: 'Playfair Display', headingFont: '' }))!;
    expect(text).toContain('family=Playfair+Display:wght@400;600;700');
  });

  it('lists one @font-face per weight and never repeats a file', () => {
    addFont();
    addFont({ id: 'f2', weight: '700', objectKey: 'f/f2/Harman-Sans-Bold.woff2', fileName: 'Harman-Sans-Bold.woff2', publicUrl: 'https://veneer.page/f/f2/Harman-Sans-Bold.woff2' });
    // Same family in both roles: the file must appear exactly once.
    const text = typographyGuidance(db, appearance({ font: 'Harman Sans', headingFont: 'Harman Sans' }))!;
    expect(text.match(/@font-face/g)).toHaveLength(2);
    expect(text.match(/f\/f1\/Harman-Sans\.woff2/g)).toHaveLength(1);
  });
});

describe('r2 putObject', () => {
  it('sends the font bytes with an immutable cache header', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await putObject(
      { accountId: 'acct', apiToken: 'secret-token', bucket: 'veneer-pages' },
      'f/f1/Harman-Sans.woff2',
      fontBytes('wOF2'),
      'font/woff2',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/r2/buckets/veneer-pages/objects/f/f1/Harman-Sans.woff2');
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('font/woff2');
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect((init.body as ArrayBuffer).byteLength).toBe(68);
  });

  it('surfaces the Cloudflare message without leaking the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: 'Bucket not found' }] }), {
        status: 404,
      }),
    );
    await expect(
      putObject({ accountId: 'a', apiToken: 'secret-token', bucket: 'b' }, 'f/x/y.woff2', fontBytes('wOF2'), 'font/woff2'),
    ).rejects.toThrow(/Bucket not found/);
    await expect(
      putObject({ accountId: 'a', apiToken: 'secret-token', bucket: 'b' }, 'f/x/y.woff2', fontBytes('wOF2'), 'font/woff2'),
    ).rejects.not.toThrow(/secret-token/);
  });
});
