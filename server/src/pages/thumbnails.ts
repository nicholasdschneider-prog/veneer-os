import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeVeneerBrowserSession, runAgentBrowser } from '../mcp/agentBrowser.js';
import { createVeneerBrowserRemote, type VeneerBrowserRemote } from '../veneerBrowser/remoteClient.js';

/**
 * Best-effort PNG thumbnails for published pages, captured after each content
 * publish (and lazily for pages that predate the feature). One capture runs at a
 * time; failures only log — publishing never depends on a capture. Thumbnails
 * live at <dataDir>/page-thumbnails/<pageId>.png and are read by
 * GET /api/pages/:id/thumbnail; the chat artifact card falls back to a styled
 * placeholder when none exists.
 *
 * Captures run on the Veneer Browser VM, never in a browser on this host.
 * Published HTML is arbitrary user content that anyone with an account can
 * publish, and a host-side browser rendering it can reach this machine's
 * loopback services (runner IPC, terminal, app-runner proxy, desktop) — all of
 * which treat the loopback bind as their only authentication. A subresource or
 * redirect to http://127.0.0.1:<port>/… would then be photographed and handed
 * back to the publisher through the thumbnail route. The VM has no route to this
 * host's loopback, which closes that path. When the VM is not configured no
 * thumbnail is captured at all; there is deliberately no local fallback.
 *
 * Every capture gets its own throwaway remote profile and its own agent-browser
 * session name, so no cookie, storage or tab state survives from one user's page
 * to the next.
 */

/** Project scope the throwaway capture profiles are created under. */
const CAPTURE_SCOPE = 'page-thumbnails';
const CAPTURE_TIMEOUT_MS = 30_000;
// Portrait viewport near the artifact card's 58x78 aspect; set before open so
// the page lays out at this size.
const VIEWPORT_WIDTH = '800';
const VIEWPORT_HEIGHT = '1080';
// A failed capture (browser unavailable, page unreachable) retries at most this
// often, so a strip that keeps requesting a missing thumbnail cannot spin the
// browser continuously.
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export interface PageThumbnails {
  /** Absolute thumbnail path for a page id, or null when storage is unavailable. */
  fileFor(pageId: string): string | null;
  /** Fire-and-forget capture; serialized and throttled internally. `force`
      bypasses the retry cooldown (publish-time captures must always refresh). */
  capture(pageId: string, url: string, options?: { force?: boolean }): void;
}

export function createPageThumbnails(options: {
  dataDir?: string;
  log?: Pick<Console, 'warn'>;
  /** Veneer Browser manager address + identity; without it captures are skipped. */
  browser?: {
    baseUrl: string | null;
    identityFile?: string | null;
    lanUrl?: string | null;
    lanCaFile?: string | null;
  } | null;
  /** Injectable for tests; production uses the real agent-browser runner. */
  run?: typeof runAgentBrowser;
  /** Injectable for tests; stops the local agent-browser daemon after a capture. */
  closeSession?: typeof closeVeneerBrowserSession;
  /** Injectable for tests; defaults to a client built from `browser`. */
  remote?: VeneerBrowserRemote | null;
}): PageThumbnails {
  const {
    dataDir,
    log = console,
    run = runAgentBrowser,
    closeSession = closeVeneerBrowserSession,
  } = options;
  const remote = options.remote
    ?? (options.browser?.baseUrl
      ? createVeneerBrowserRemote({
        baseUrl: options.browser.baseUrl,
        identityFile: options.browser.identityFile ?? null,
        lanUrl: options.browser.lanUrl ?? null,
        lanCaFile: options.browser.lanCaFile ?? null,
      })
      : null);
  const dir = dataDir ? path.join(dataDir, 'page-thumbnails') : null;
  const lastAttemptAt = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const fileFor = (pageId: string): string | null => {
    if (!dir || !/^[A-Za-z0-9-]+$/.test(pageId)) return null;
    return path.join(dir, `${pageId}.png`);
  };

  const shoot = async (bustedUrl: string, target: string): Promise<void> => {
    if (!remote?.configured()) {
      throw new Error('the Veneer Browser VM is not configured on this client');
    }
    // Fresh ids per capture: the remote profile is created, used and deleted
    // here, and the session name derives from both, so two captures never share
    // browser state.
    const captureId = `page-thumbnail-${crypto.randomUUID()}`;
    const profileId = crypto.randomUUID();
    await remote.createTemporary(CAPTURE_SCOPE, profileId, 'Page thumbnail capture');
    try {
      await remote.start(CAPTURE_SCOPE, profileId);
      const ticket = await remote.ticket(CAPTURE_SCOPE, profileId, 'agent');
      const cdpCaFile = remote.cdpCaFile(ticket.cdpUrl);
      const runOptions = {
        conversationId: captureId,
        workspaceDir: dir!,
        timeoutMs: CAPTURE_TIMEOUT_MS,
        remoteCdpUrl: ticket.cdpUrl,
        remoteSessionId: profileId,
        trustedCdpOrigin: ticket.cdpUrl,
        ...(cdpCaFile ? { cdpCaFile } : {}),
      };
      try {
        const opened = await run(['open', bustedUrl], runOptions);
        if (opened.exitCode !== 0) throw new Error(opened.stderr || `open exited ${opened.exitCode}`);
        // Portrait viewport after open (settings apply to the live session);
        // cosmetic, so tolerate CLI versions without the command.
        await run(['set', 'viewport', VIEWPORT_WIDTH, VIEWPORT_HEIGHT], runOptions).catch(() => undefined);
        const shot = await run(['screenshot'], runOptions);
        if (shot.exitCode !== 0 || !shot.screenshotPath || !fs.existsSync(shot.screenshotPath)) {
          throw new Error(shot.stderr || `screenshot exited ${shot.exitCode}`);
        }
        fs.renameSync(shot.screenshotPath, target);
      } finally {
        // Remote sessions run with the daemon idle timeout disabled, so the
        // local CLI daemon has to be stopped by hand or it outlives the capture.
        await closeSession({
          conversationId: captureId,
          remoteSessionId: profileId,
          workspaceDir: dir!,
        }).catch(() => undefined);
      }
    } finally {
      // The manager refuses to delete a running profile, so it is stopped first.
      // A leak keeps a container alive on the VM, so it is reported even though
      // it cannot fail a capture that already produced its PNG.
      await remote.stop(CAPTURE_SCOPE, profileId)
        .then(() => remote.delete(CAPTURE_SCOPE, profileId))
        .catch((error: Error) => {
          log.warn(`[page-thumbnails] could not discard capture profile ${profileId}: ${error.message}`);
        });
    }
  };

  const capture = (pageId: string, url: string, options?: { force?: boolean }): void => {
    const target = fileFor(pageId);
    if (!target || !/^https?:\/\//i.test(url)) return;
    const now = Date.now();
    if (!options?.force && now - (lastAttemptAt.get(pageId) ?? 0) < RETRY_COOLDOWN_MS) return;
    lastAttemptAt.set(pageId, now);
    // Cache-bust so an update's capture cannot photograph the previous revision.
    const bustedUrl = `${url}${url.includes('?') ? '&' : '?'}vp-thumb=${now}`;
    chain = chain
      .then(async () => {
        fs.mkdirSync(dir!, { recursive: true });
        await shoot(bustedUrl, target);
      })
      .catch((err: Error) => {
        log.warn(`[page-thumbnails] capture failed for ${pageId}: ${err.message}`);
      });
  };

  return { fileFor, capture };
}
