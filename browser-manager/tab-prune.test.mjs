import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlankPage, pruneTabs, tabsToClose } from './tab-prune.mjs';

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
