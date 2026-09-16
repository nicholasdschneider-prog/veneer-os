import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { pruneExpiredPages } from '../src/pages/expiry.js';
import { ensurePageExpiryLifecycle, putHtml } from '../src/pages/r2.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const r2 = { accountId: 'account', apiToken: 'secret', bucket: 'pages' };

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function context(): AppContext {
  return {
    db,
    config: {
      pages: {
        ...r2,
        publicBase: 'https://veneer.page',
      },
    },
  } as unknown as AppContext;
}

describe('published page expiry', () => {
  it('removes expired metadata and its public object while keeping active pages', async () => {
    db.prepare(
      `INSERT INTO pages (id, slug, title, expires_at)
       VALUES
         ('expired', 'expired-slug', 'Expired', datetime('now', '-1 minute')),
         ('active', 'active-slug', 'Active', datetime('now', '+1 day'))`,
    ).run();
    const remove = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await expect(pruneExpiredPages(context())).resolves.toBe(1);

    expect(db.prepare('SELECT id FROM pages ORDER BY id').all()).toEqual([{ id: 'active' }]);
    expect(db.prepare('SELECT * FROM page_expiry_deletions').all()).toEqual([]);
    expect(remove).toHaveBeenCalledWith(
      expect.stringContaining('/objects/p/expired-slug'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('keeps a failed object deletion in the durable retry queue', async () => {
    db.prepare(
      `INSERT INTO pages (id, slug, title, expires_at)
       VALUES ('expired', 'retry-slug', 'Expired', datetime('now', '-1 minute'))`,
    ).run();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ message: 'temporary failure' }] }), { status: 500 }),
    );

    await pruneExpiredPages(context());
    expect(db.prepare('SELECT page_id, slug FROM page_expiry_deletions').all()).toEqual([
      { page_id: 'expired', slug: 'retry-slug' },
    ]);
    expect(warning).toHaveBeenCalled();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await pruneExpiredPages(context());
    expect(db.prepare('SELECT * FROM page_expiry_deletions').all()).toEqual([]);
  });

  it('does not expire a page while its replacement content is publishing', async () => {
    db.prepare(
      `INSERT INTO pages (id, slug, title, expires_at)
       VALUES ('publishing', 'publishing-slug', 'Publishing', datetime('now', '-1 minute'))`,
    ).run();

    await expect(pruneExpiredPages(context(), ['publishing'])).resolves.toBe(0);

    expect(db.prepare("SELECT id FROM pages WHERE id = 'publishing'").get()).toEqual({ id: 'publishing' });
  });

  it('preserves other lifecycle rules when it installs the seven-day R2 rule', async () => {
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: { rules: [{ id: 'keep-me', enabled: true, conditions: { prefix: 'logs/' } }] },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await ensurePageExpiryLifecycle(r2, 604_800);

    const [, options] = request.mock.calls[1]!;
    const body = JSON.parse(String(options?.body)) as {
      rules: Array<{ id: string; conditions: { prefix: string }; deleteObjectsTransition?: { condition: { maxAge: number } } }>;
    };
    expect(body.rules.map((rule) => rule.id)).toEqual(['keep-me', 'veneer-pages-expire-7-days']);
    expect(body.rules[1]).toMatchObject({
      conditions: { prefix: 'p/' },
      deleteObjectsTransition: { condition: { maxAge: 604_800 } },
    });
  });

  it('marks uploaded HTML as non-cacheable', async () => {
    const upload = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

    await putHtml(r2, 'p/page-slug', '<!doctype html>');

    expect(upload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Cache-Control': 'no-store, max-age=0' }),
      }),
    );
  });
});
