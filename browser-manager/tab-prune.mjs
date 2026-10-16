// A working copy restores its last session on every open, so any tab left open
// at turn end comes back next time and keeps costing memory and disk. Before a
// copy pauses, everything but the page the bot was last on is closed.
//
// Chrome's /json/list orders targets by last activity, most recent first, so
// the first real web page there is the one the bot was working in.

const BLANK = /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page|chrome-search:\/\/local-ntp)/i;

export function isBlankPage(url) {
  return !url || BLANK.test(String(url));
}

/** Ids of the page targets to close; always leaves exactly one page open. */
export function tabsToClose(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t && t.type === 'page' && typeof t.id === 'string');
  if (pages.length <= 1) return [];
  const keep = pages.find((t) => !isBlankPage(t.url)) ?? pages[0];
  return pages.filter((t) => t !== keep).map((t) => t.id);
}

/**
 * Session restore opens tabs for a moment after DevTools answers, so a fresh
 * copy is pruned only once its page count has held still for `stableMs`, or
 * after `maxMs` either way. Returns the last count seen (null if never read).
 */
export async function waitForStableTabs(port, { stableMs = 500, maxMs = 3000, intervalMs = 100, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + maxMs;
  let last = null;
  let since = Date.now();
  while (Date.now() < deadline) {
    let count;
    try {
      const listed = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (!listed.ok) return last;
      count = (await listed.json()).filter((t) => t && t.type === 'page').length;
    } catch {
      // DevTools was already answering when this is called, so a failure means
      // the list is unreachable, not that restore is still running.
      return last;
    }
    if (count !== last) { last = count; since = Date.now(); }
    else if (Date.now() - since >= stableMs) return count;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

/**
 * Best effort and bounded: a page that will not close (a stuck dialog, a slow
 * beforeunload) stays open, and the browser stop that follows ends it anyway.
 * Never throws.
 */
export async function pruneTabs(port, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(100, deadline - Date.now());
  const base = `http://127.0.0.1:${port}`;
  try {
    const listed = await fetchImpl(`${base}/json/list`, { signal: AbortSignal.timeout(remaining()) });
    if (!listed.ok) return { closed: 0, failed: 0 };
    const ids = tabsToClose(await listed.json());
    let closed = 0;
    let failed = 0;
    for (const id of ids) {
      if (Date.now() >= deadline) { failed += 1; continue; }
      try {
        const response = await fetchImpl(`${base}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(Math.min(1500, remaining())) });
        if (response.ok) closed += 1; else failed += 1;
      } catch { failed += 1; }
    }
    return { closed, failed };
  } catch {
    return { closed: 0, failed: 0 };
  }
}
