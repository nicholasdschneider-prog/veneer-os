import { describe, expect, it, vi } from 'vitest';
import {
  formatTabList,
  matchTab,
  normalizeTabUrl,
  parseTabList,
  reuseOrOpenTab,
  urlsMatchExactly,
} from '../src/veneerBrowser/tabReuse.js';

const TEXT_LIST = [
  't1 [current] Amazon.com — https://www.amazon.com/',
  't2 Example Store Admin — https://admin.example-store.test/orders',
].join('\n');

describe('parseTabList', () => {
  it('does not borrow the following tab URL for a blank or internal tab', () => {
    for (const url of ['about:blank', 'chrome://newtab/', '']) {
      const tabs = parseTabList(`→ [t1] Blank - ${url}\n  [t7] Login - https://login.test/path`);
      expect(tabs.map((tab) => tab.url)).toEqual(['', 'https://login.test/path']);
      expect(tabs[0]?.current).toBe(true);
    }
    expect(parseTabList('[t7] Login\n  https://login.test/path')[0]?.url).toBe('https://login.test/path');
  });

  it('reads text lines with current markers and urls', () => {
    expect(parseTabList(TEXT_LIST)).toEqual([
      { id: 't1', url: 'https://www.amazon.com/', title: 'Amazon.com', current: true },
      { id: 't2', url: 'https://admin.example-store.test/orders', title: 'Example Store Admin', current: false },
    ]);
  });

  it('reads json tab lists', () => {
    const json = JSON.stringify({
      tabs: [
        { tabId: 't1', url: 'https://www.amazon.com/', title: 'Amazon', active: true },
        { id: 't2', url: 'https://admin.example-store.test/orders', title: 'Admin', current: false },
      ],
    });
    expect(parseTabList(json)).toEqual([
      { id: 't1', url: 'https://www.amazon.com/', title: 'Amazon', current: true },
      { id: 't2', url: 'https://admin.example-store.test/orders', title: 'Admin', current: false },
    ]);
  });

  it('reads the --json envelope shape {"success":true,"data":{"tabs":[...]}}', () => {
    const json = JSON.stringify({
      success: true,
      data: {
        tabs: [
          { tabId: 't1', url: 'https://www.amazon.com/', title: 'Amazon', active: true },
          { id: 't2', url: 'https://admin.example-store.test/orders', title: 'Admin', current: false },
        ],
      },
    });
    expect(parseTabList(json)).toEqual([
      { id: 't1', url: 'https://www.amazon.com/', title: 'Amazon', current: true },
      { id: 't2', url: 'https://admin.example-store.test/orders', title: 'Admin', current: false },
    ]);
  });

  it('reads an enveloped items array and a top-level items array', () => {
    const enveloped = JSON.stringify({ success: true, data: { items: [{ tabId: 't1', url: 'https://a.test/', active: true }] } });
    expect(parseTabList(enveloped)).toEqual([{ id: 't1', url: 'https://a.test/', title: '', current: true }]);
    const topLevel = JSON.stringify({ items: [{ tabId: 't2', url: 'https://b.test/', active: false }] });
    expect(parseTabList(topLevel)).toEqual([{ id: 't2', url: 'https://b.test/', title: '', current: false }]);
  });

  it('reads an enveloped data array directly, without a nested tabs/items key', () => {
    const json = JSON.stringify({ success: true, data: [{ tabId: 't1', url: 'https://a.test/', active: true }] });
    expect(parseTabList(json)).toEqual([{ id: 't1', url: 'https://a.test/', title: '', current: true }]);
  });

  it('degrades success:false and empty-envelope payloads to an empty list instead of throwing', () => {
    expect(parseTabList(JSON.stringify({ success: false, error: 'daemon busy' }))).toEqual([]);
    expect(parseTabList(JSON.stringify({ success: true, data: {} }))).toEqual([]);
    expect(parseTabList(JSON.stringify({ success: true, data: null }))).toEqual([]);
    expect(parseTabList('{not valid json')).toEqual([]);
  });

  it('picks up a url on the following line', () => {
    expect(parseTabList('t3 Docs\nhttps://docs.example.com/guide')).toEqual([
      { id: 't3', url: 'https://docs.example.com/guide', title: 'Docs', current: false },
    ]);
  });

  it('reads the current arrow format emitted by Agent Browser', () => {
    expect(parseTabList('→ [t1] Example - https://example.com/\n  [t2] Docs - https://docs.example.com/')).toEqual([
      { id: 't1', url: 'https://example.com/', title: 'Example', current: true },
      { id: 't2', url: 'https://docs.example.com/', title: 'Docs', current: false },
    ]);
  });
});

describe('url matching', () => {
  it('ignores hashes, trailing slashes, and default ports', () => {
    expect(urlsMatchExactly('https://admin.example-store.test/orders/', 'https://admin.example-store.test/orders#top')).toBe(true);
    expect(urlsMatchExactly('https://admin.example-store.test:443/orders', 'https://admin.example-store.test/orders')).toBe(true);
    expect(normalizeTabUrl('https://Admin.Example-Store.test./orders/')?.origin).toBe('https://admin.example-store.test');
  });

  it('prefers an exact tab, then a path prefix, then the same origin', () => {
    const tabs = parseTabList(TEXT_LIST);
    expect(matchTab(tabs, 'https://admin.example-store.test/orders')?.id).toBe('t2');
    expect(matchTab(tabs, 'https://admin.example-store.test/orders/42')?.id).toBe('t2');
    expect(matchTab(tabs, 'https://admin.example-store.test/')?.id).toBe('t2');
    expect(matchTab(tabs, 'https://www.amazon.com/dp/B00')?.id).toBe('t1');
    expect(matchTab(tabs, 'https://other.example/') ).toBeNull();
  });
});

describe('reuseOrOpenTab', () => {
  it('switches to a matching tab instead of replacing the current page', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'list') return { stdout: TEXT_LIST, stderr: '', exitCode: 0 };
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    const result = await reuseOrOpenTab(run, 'https://admin.example-store.test/orders');
    expect(run).toHaveBeenCalledWith(['tab', 't2']);
    expect(run).not.toHaveBeenCalledWith(['open', 'https://admin.example-store.test/orders']);
    expect(run).not.toHaveBeenCalledWith(['tab', 'new', 'https://admin.example-store.test/orders']);
    expect(result.summary).toContain('t2');
    expect(formatTabList(result.tabs)).toContain('t2');
  });

  it('opens a new tab when nothing matches', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'list') return { stdout: TEXT_LIST, stderr: '', exitCode: 0 };
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    await reuseOrOpenTab(run, 'https://products.local.example.com/');
    expect(run).toHaveBeenCalledWith(['tab', 'new', 'https://products.local.example.com/']);
    expect(run).not.toHaveBeenCalledWith(['open', 'https://products.local.example.com/']);
  });

  it('loads the requested page after switching when the tab is only a prefix match', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab' && args[1] === 'list') return { stdout: TEXT_LIST, stderr: '', exitCode: 0 };
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    await reuseOrOpenTab(run, 'https://admin.example-store.test/orders/42');
    expect(run).toHaveBeenCalledWith(['tab', 't2']);
    expect(run).toHaveBeenCalledWith(['open', 'https://admin.example-store.test/orders/42']);
  });
});
