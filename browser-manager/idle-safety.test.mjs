import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { inspectIdlePages } from './idle-safety.mjs';

async function fixture(t, { dirty = false, beforeUnload = false, refuse = false, stall = false, iframe = false } = {}) {
  const server = http.createServer(); const wss = new WebSocketServer({ server }); const commands = [];
  wss.on('connection', socket => socket.on('message', bytes => {
    const m = JSON.parse(String(bytes)); commands.push(m);
    if (stall) return;
    if (refuse) return socket.send(JSON.stringify({ id: m.id, error: { message: 'unavailable' } }));
    if (m.method === 'Runtime.enable') for (const frameId of ['main', 'child']) socket.send(JSON.stringify({ method: 'Runtime.executionContextCreated', sessionId: m.sessionId, params: { context: { id: frameId === 'main' ? 10 : 20, auxData: { isDefault: true, frameId } } } }));
    let result = {};
    if (m.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'tab' }] };
    if (m.method === 'Target.attachToTarget') result = { sessionId: 'session' };
    if (m.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main' }, ...(iframe ? { childFrames: [{ frame: { id: 'child' } }] } : {}) } };
    if (m.method === 'Page.createIsolatedWorld') result = { executionContextId: m.params.frameId === 'main' ? 1 : 2 };
    if (m.method === 'Runtime.evaluate') result = { result: m.params.expression === 'window' ? { objectId: 'window' } : { value: dirty && (!iframe || m.params.contextId === 2) } };
    if (m.method === 'DOMDebugger.getEventListeners') result = { listeners: beforeUnload ? [{ type: 'beforeunload' }] : [] };
    socket.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}`, commands };
}

test('allows a verified clean page without returning page content', async t => {
  const f = await fixture(t); assert.deepEqual(await inspectIdlePages(f.url), { safe: true });
  assert.ok(f.commands.some(m => m.method === 'DOMDebugger.getEventListeners'));
});
for (const scenario of [{ dirty: true }, { beforeUnload: true }, { dirty: true, iframe: true }]) {
  test(`protects unfinished work ${JSON.stringify(scenario)}`, async t => {
    const f = await fixture(t, scenario); assert.deepEqual(await inspectIdlePages(f.url), { safe: false, reason: 'unfinished_page' });
  });
}
for (const scenario of [{ refuse: true }, { stall: true }]) {
  test(`fails closed and bounds inspection ${JSON.stringify(scenario)}`, async t => {
    const f = await fixture(t, scenario); assert.deepEqual(await inspectIdlePages(f.url, { timeoutMs: 100 }), { safe: false, reason: 'page_check_unavailable' });
  });
}
