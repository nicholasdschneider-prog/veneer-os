export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  current: boolean;
  label?: string;
}

export interface TabRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunBrowserCommand = (args: string[]) => Promise<TabRunResult>;

const TAB_ID = /\bt\d+\b/i;
const HTTP_URL = /https?:\/\/[^\s\]]+/i;

export function normalizeTabUrl(value: string): { href: string; origin: string; pathname: string } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    url.hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    return { href: url.href, origin: url.origin.toLowerCase(), pathname: url.pathname || '/' };
  } catch {
    return null;
  }
}

export function urlsMatchExactly(left: string, right: string): boolean {
  const a = normalizeTabUrl(left);
  const b = normalizeTabUrl(right);
  return Boolean(a && b && a.href === b.href);
}

function pathPrefixMatch(requested: string, tabPath: string): boolean {
  if (requested === '/' || tabPath === '/') return false;
  return requested === tabPath || requested.startsWith(`${tabPath}/`) || tabPath.startsWith(`${requested}/`);
}

function asTab(value: Record<string, unknown>): BrowserTab | null {
  const id = String(value.tabId ?? value.id ?? value.tab_id ?? '').trim();
  if (!/^t\d+$/i.test(id)) return null;
  const url = String(value.url ?? value.href ?? '').trim();
  const title = String(value.title ?? value.name ?? '').trim();
  const label = String(value.label ?? '').trim();
  const current = value.current === true || value.active === true || value.selected === true;
  return { id: id.toLowerCase(), url, title, current, ...(label ? { label } : {}) };
}

/**
 * `tab list --json` wraps its payload — {"success":true,"data":{"tabs":[…]}} —
 * while the plain object form carries `tabs` (or `items`) at the top level.
 */
function jsonTabRows(value: Record<string, unknown>): unknown {
  const direct = value.tabs ?? value.items;
  if (direct !== undefined) return direct;
  const data = value.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const inner = data as Record<string, unknown>;
    return inner.tabs ?? inner.items ?? [];
  }
  return [];
}

function parseJsonTabs(output: string): BrowserTab[] | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? jsonTabRows(parsed as Record<string, unknown>)
        : [];
    if (!Array.isArray(rows)) return null;
    const tabs = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
      .map(asTab)
      .filter((tab): tab is BrowserTab => Boolean(tab));
    return tabs;
  } catch {
    return null;
  }
}

function parseTextLine(line: string): BrowserTab | null {
  const idMatch = line.match(TAB_ID);
  if (!idMatch) return null;
  const urlMatch = line.match(HTTP_URL);
  const current = /\[(?:current|active|selected)\]/i.test(line) || /^\s*(?:→|->)\s*/.test(line);
  const withoutId = line
    .replace(/^\s*(?:→|->)\s*/, '')
    .replace(TAB_ID, '')
    .replace(HTTP_URL, '')
    .replace(/\[(?:current|active|selected)\]/ig, '')
    .replace(/\[\s*\]/g, '');
  const title = withoutId.replace(/^[—\-|:.\s]+|[—\-|:.\s]+$/g, '').trim();
  return {
    id: idMatch[0]!.toLowerCase(),
    url: urlMatch?.[0]?.replace(/[.,;]+$/, '') ?? '',
    title,
    current,
  };
}

export function parseTabList(output: string): BrowserTab[] {
  const json = parseJsonTabs(output);
  if (json) return json;
  const tabs: BrowserTab[] = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const tab = parseTextLine(line);
    if (!tab) continue;
    if (!tab.url) {
      const next = lines[index + 1] ?? '';
      const urlMatch = next.match(HTTP_URL);
      if (urlMatch && !TAB_ID.test(next)) tab.url = urlMatch[0]!.replace(/[.,;]+$/, '');
    }
    tabs.push(tab);
  }
  return tabs;
}

export function formatTabList(tabs: BrowserTab[]): string {
  if (!tabs.length) return 'Tabs: none listed.';
  return [
    'Tabs:',
    ...tabs.map((tab) => {
      const current = tab.current ? ' [current]' : '';
      const title = tab.title || tab.label || tab.id;
      const url = tab.url || '(no url)';
      return `${tab.id}${current} ${title} — ${url}`;
    }),
  ].join('\n');
}

export function matchTab(tabs: BrowserTab[], requestedUrl: string): BrowserTab | null {
  const wanted = normalizeTabUrl(requestedUrl);
  if (!wanted) return null;
  const usable = tabs.filter((tab) => normalizeTabUrl(tab.url));
  const pick = (candidates: BrowserTab[]): BrowserTab | null => (
    candidates.find((tab) => tab.current) ?? candidates[0] ?? null
  );
  const exact = usable.filter((tab) => urlsMatchExactly(tab.url, requestedUrl));
  if (exact.length) return pick(exact);
  const prefixed = usable.filter((tab) => {
    const have = normalizeTabUrl(tab.url);
    return Boolean(have && have.origin === wanted.origin && pathPrefixMatch(wanted.pathname, have.pathname));
  }).sort((left, right) => (normalizeTabUrl(right.url)?.pathname.length ?? 0) - (normalizeTabUrl(left.url)?.pathname.length ?? 0));
  if (prefixed.length) return pick(prefixed);
  const origin = usable.filter((tab) => normalizeTabUrl(tab.url)?.origin === wanted.origin);
  return pick(origin);
}

function combinedOutput(result: TabRunResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

export async function listBrowserTabs(run: RunBrowserCommand): Promise<{ tabs: BrowserTab[]; raw: string }> {
  const listed = await run(['tab', 'list']);
  const raw = combinedOutput(listed);
  return { tabs: parseTabList(raw), raw };
}

export async function reuseOrOpenTab(run: RunBrowserCommand, url: string): Promise<{ summary: string; tabs: BrowserTab[]; rawList: string }> {
  let listed: { tabs: BrowserTab[]; raw: string };
  try {
    listed = await listBrowserTabs(run);
  } catch {
    await run(['tab', 'new', url]);
    return { summary: `Opened a new tab for ${url}.`, tabs: [], rawList: '' };
  }
  const match = matchTab(listed.tabs, url);
  if (match) {
    if (!match.current) await run(['tab', match.id]);
    if (!urlsMatchExactly(match.url, url)) await run(['open', url]);
    const after = await listBrowserTabs(run).catch(() => listed);
    const samePage = urlsMatchExactly(match.url, url);
    return {
      summary: samePage
        ? `Switched to existing tab ${match.id} (${match.url || url}).`
        : `Switched to existing tab ${match.id} and opened ${url}.`,
      tabs: after.tabs,
      rawList: after.raw,
    };
  }
  await run(['tab', 'new', url]);
  const after = await listBrowserTabs(run).catch(() => listed);
  return {
    summary: `Opened a new tab for ${url}.`,
    tabs: after.tabs,
    rawList: after.raw,
  };
}

export function appendTabList(text: string, tabs: BrowserTab[], rawFallback = ''): string {
  const listing = tabs.length ? formatTabList(tabs) : rawFallback.trim() || formatTabList(tabs);
  return `${text}\n${listing}`;
}
