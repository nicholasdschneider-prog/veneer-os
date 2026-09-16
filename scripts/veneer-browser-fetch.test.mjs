import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fetchBrowserUrl } from './veneer-browser-fetch.mjs';

test('local helper reads existing credentials at call time and forwards structured requests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-reader-helper-'));
  const credential = path.join(directory, 'runner-ipc-secret');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, token: req.headers['x-vp-ipc-secret'], body: JSON.parse(raw) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, fetched_at: '2026-09-10T00:00:00Z', text: 'Ready' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = { url: 'https://example.com', wait_for: { min_rows: 2 } };
    for (const value of ['test-first', 'test-rotated']) {
      fs.writeFileSync(credential, value, { mode: 0o600 });
      const result = await fetchBrowserUrl({ dataDir: directory, port: server.address().port, conversationId: 'chat-id', request });
      assert.equal(result.ok, true);
    }
    assert.deepEqual(requests.map(item => item.token), ['test-first', 'test-rotated']);
    assert.deepEqual(requests[0].body, { convId: 'chat-id', request });
    assert.equal(requests[0].path, '/rpc/veneerBrowserFetchUrl');
    fs.unlinkSync(credential);
    await assert.rejects(fetchBrowserUrl({ dataDir: directory, port: server.address().port, conversationId: 'chat-id', request }), /Could not reach the local Veneer runner/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local helper never follows an HTTP redirect with the service credential', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-reader-redirect-'));
  fs.writeFileSync(path.join(directory, 'runner-ipc-secret'), 'test-only', { mode: 0o600 });
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(302, { location: '/unexpected' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchBrowserUrl({ dataDir: directory, port: server.address().port,
      conversationId: 'chat', request: { url: 'https://example.com' } }), /Could not reach/);
    assert.equal(calls, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
