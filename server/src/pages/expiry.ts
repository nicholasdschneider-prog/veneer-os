import type { AppContext } from '../context.js';
import { deleteObject, ensurePageExpiryLifecycle, type R2Config } from './r2.js';

export const PAGE_TTL_DAYS = 7;
export const PAGE_TTL_SECONDS = PAGE_TTL_DAYS * 24 * 60 * 60;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 100;

interface PendingDeletion {
  page_id: string;
  slug: string;
}

function r2Config(ctx: AppContext): R2Config | null {
  const pages = ctx.config.pages;
  return pages
    ? {
        accountId: pages.accountId,
        apiToken: pages.apiToken,
        bucket: pages.bucket,
      }
    : null;
}

/**
 * Atomically hide expired pages and move their object keys to a durable retry
 * queue. Deleting the page row first makes an in-place republish return 404
 * instead of racing with an object deletion already in flight.
 */
export async function pruneExpiredPages(ctx: AppContext, activePublishIds: readonly string[] = []): Promise<number> {
  const publishPlaceholders = activePublishIds.map(() => '?').join(', ');
  const publishGuard = activePublishIds.length > 0 ? `AND id NOT IN (${publishPlaceholders})` : '';
  const queueExpired = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO page_expiry_deletions (page_id, slug)
         SELECT id, slug
         FROM pages
         WHERE COALESCE(expires_at, datetime(updated_at, '+7 days')) <= datetime('now')
           ${publishGuard}`,
      )
      .run(...activePublishIds);
    return ctx.db
      .prepare(
        `DELETE FROM pages
         WHERE COALESCE(expires_at, datetime(updated_at, '+7 days')) <= datetime('now')
           ${publishGuard}`,
      )
      .run(...activePublishIds).changes;
  });
  const expiredCount = queueExpired();

  const r2 = r2Config(ctx);
  if (!r2) return expiredCount;

  const pending = ctx.db
    .prepare(
      `SELECT page_id, slug
       FROM page_expiry_deletions
       ORDER BY queued_at, page_id
       LIMIT ?`,
    )
    .all(DELETE_BATCH_SIZE) as PendingDeletion[];

  await Promise.all(
    pending.map(async (page) => {
      try {
        await deleteObject(r2, `p/${page.slug}`);
        ctx.db.prepare('DELETE FROM page_expiry_deletions WHERE page_id = ?').run(page.page_id);
      } catch (error) {
        console.warn(`[pages] expired object cleanup failed for ${page.page_id}: ${(error as Error).message}`);
      }
    }),
  );
  return expiredCount;
}

export interface PageExpiryService {
  beginPublish(pageId: string): () => void;
  close(): void;
}

/** Start the prompt local cleanup and the outage-safe R2 lifecycle check. */
export function startPageExpiry(ctx: AppContext): PageExpiryService {
  let running = false;
  let lifecycleReady = false;
  let nextLifecycleAttemptAt = 0;
  const activePublishes = new Map<string, number>();

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await pruneExpiredPages(ctx, [...activePublishes.keys()]);
      const r2 = r2Config(ctx);
      if (r2 && !lifecycleReady && Date.now() >= nextLifecycleAttemptAt) {
        nextLifecycleAttemptAt = Date.now() + 60 * 60 * 1000;
        try {
          await ensurePageExpiryLifecycle(r2, PAGE_TTL_SECONDS);
          lifecycleReady = true;
        } catch (error) {
          console.warn(`[pages] could not ensure R2 expiry lifecycle: ${(error as Error).message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), CLEANUP_INTERVAL_MS);
  timer.unref?.();

  return {
    beginPublish(pageId) {
      activePublishes.set(pageId, (activePublishes.get(pageId) ?? 0) + 1);
      return () => {
        const remaining = (activePublishes.get(pageId) ?? 1) - 1;
        if (remaining > 0) activePublishes.set(pageId, remaining);
        else activePublishes.delete(pageId);
      };
    },
    close() {
      clearInterval(timer);
    },
  };
}
