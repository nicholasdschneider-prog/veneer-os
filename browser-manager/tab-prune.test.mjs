import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlankPage, pruneTabs, tabsToClose, waitForStableTabs } from './tab-prune.mjs';

const page = (id, url) => ({ id, type: 'page', url });

test('keeps the most recently active real page and closes every other page', () => {
  const targets = [page('a', 'about:blank'), page('b', 'https://example.com/x'), { id: 'w', type: 'service_worker', url: 'https://example.com/sw.js' }, page('c', 'https://old.example.com'), page('d', 'chrome://newtab/')];
  assert.deepEqual(tabsToClose(targets), ['a', 'c', 'd']);
});

test('leaves one page when every page is blank, and nothing to do with one page', () => {
  assert.deepEqual(tabsToClose([page('a', 'about:blank'), page('b', 'chrome://new-tab-page/')]), ['b']);
  assert.deepEqual(tabsToClose([page('only', 'about:blank')]), []);
  assert.deepEqual(tabsToClose([]), []);
  assert.deepEqual(tabsToClose(null), []);
});

test('recognizes blank and new-tab pages', () => {
  for (const url of ['about:blank', 'about:blank#veneer-script-1', 'chrome://newtab/', 'chrome://new-tab-page/', '', undefined]) assert.equal(isBlankPage(url), true, String(url));
  for (const url of ['https://mail.google.com', 'http://example.com/about:blank']) assert.equal(isBlankPage(url), false, url);
});

test('pruning is best effort: failed closes are counted and a dead port never throws', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/json/list')) return { ok: true, json: async () => [page('keep', 'https://a.example'), page('x', 'about:blank'), page('y', 'https://b.example')] };
    if (url.endsWith('/x')) throw new Error('stuck');
    return { ok: true };
  };
  assert.deepEqual(await pruneTabs(9, { fetchImpl }), { closed: 1, failed: 1 });
  assert.equal(calls.some((url) => url.endsWith('/keep')), false);
  assert.deepEqual(await pruneTabs(9, { fetchImpl: async () => { throw new Error('down'); } }), { closed: 0, failed: 0 });
});

test('waits for restored tabs to stop appearing, and gives up at once on an unreachable list', async () => {
  const counts = [1, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  let call = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => Array.from({ length: counts[Math.min(call++, counts.length - 1)] }, (_, i) => page(String(i), 'https://x.example')) });
  assert.equal(await waitForStableTabs(9, { stableMs: 30, intervalMs: 10, maxMs: 2000, fetchImpl }), 5);
  const started = Date.now();
  assert.equal(await waitForStableTabs(9, { fetchImpl: async () => { throw new Error('refused'); } }), null);
  assert.ok(Date.now() - started < 500);
  let grows = 0;
  const growing = async () => ({ ok: true, json: async () => Array.from({ length: ++grows }, (_, i) => page(String(i), 'https://x.example')) });
  const bounded = Date.now();
  await waitForStableTabs(9, { stableMs: 1000, intervalMs: 10, maxMs: 200, fetchImpl: growing });
  assert.ok(Date.now() - bounded < 600);
});
