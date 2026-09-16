import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { relayCdp } from './cdp-relay.mjs';

async function waitUntil(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the relay');
}

test('buffers commands arriving before the Chrome address resolves and forwards them in order', { timeout: 3000 }, async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([once(upstream, 'listening'), once(gateway, 'listening')]);
  const received = [];
  upstream.on('connection', socket => socket.on('message', data => { received.push(data.toString()); socket.send(data); }));
  let resolveAddress;
  gateway.on('connection', client => relayCdp(client, () => new Promise(resolve => { resolveAddress = resolve; })));
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}`);
  try {
    await once(client, 'open');
    client.send('first'); client.send('second');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(received, []);
    const echoed = new Promise(resolve => { const items = []; client.on('message', data => { items.push(data.toString()); if (items.length === 2) resolve(items); }); });
    resolveAddress(`ws://127.0.0.1:${upstream.address().port}`);
    assert.deepEqual(await echoed, ['first', 'second']);
    assert.deepEqual(received, ['first', 'second']);
  } finally {
    client.terminate();
    for (const socket of [...upstream.clients, ...gateway.clients]) socket.terminate();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});

test('does not connect upstream after the requesting client closes during lookup', { timeout: 3000 }, async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([once(upstream, 'listening'), once(gateway, 'listening')]);
  let connections = 0, resolveAddress, downstream;
  upstream.on('connection', () => connections++);
  gateway.on('connection', client => {
    downstream = client;
    relayCdp(client, () => new Promise(resolve => { resolveAddress = resolve; }));
  });
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}`);
  try {
    await once(client, 'open');
    const closed = once(downstream, 'close');
    client.close();
    await closed;
    resolveAddress(`ws://127.0.0.1:${upstream.address().port}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(connections, 0);
  } finally {
    client.terminate();
    for (const socket of [...upstream.clients, ...gateway.clients]) socket.terminate();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});

// A control ticket is not a licence to read the Mac: the relay is the only
// boundary the native backend has, so these are the commands it refuses.
test('refuses local-file and browser-internal navigations without forwarding them', { timeout: 3000 }, async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([once(upstream, 'listening'), once(gateway, 'listening')]);
  const forwarded = [];
  const blocked = [];
  upstream.on('connection', socket => socket.on('message', data => forwarded.push(JSON.parse(data.toString()))));
  gateway.on('connection', client => relayCdp(client, () => `ws://127.0.0.1:${upstream.address().port}`, {
    downloadsDir: '/tmp/veneer-downloads',
    onBlocked: reason => blocked.push(reason),
  }));
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}`);
  try {
    await once(client, 'open');
    const replies = [];
    client.on('message', data => replies.push(JSON.parse(data.toString())));
    const refused = [
      { id: 1, method: 'Page.navigate', params: { url: 'file:///etc/passwd' } },
      { id: 2, method: 'Page.navigate', params: { url: '  FILE:///etc/passwd' } },
      { id: 3, method: 'Target.createTarget', params: { url: 'chrome://settings' } },
      { id: 4, method: 'Page.navigate', params: { url: 'view-source:file:///etc/hosts' } },
      { id: 5, method: 'Target.createTarget', params: { url: 'chrome-extension://abc/page.html' } },
      { id: 6, method: 'Page.navigate', params: { url: 'devtools://devtools/bundled/x.html' } },
      // The download path is the argument here, and it is outside the profile.
      { id: 7, method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/Users' }, sessionId: 'S1' },
      { id: 8, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/tmp/veneer-downloads/../../etc' } },
      { id: 9, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow' } },
    ];
    for (const command of refused) client.send(JSON.stringify(command));
    await waitUntil(() => replies.length === refused.length);
    assert.deepEqual(replies.map(reply => reply.id), refused.map(command => command.id));
    for (const reply of replies) assert.equal(reply.error.code, -32000);
    // The session a command was scoped to has to come back or the caller cannot
    // match the answer to its request.
    assert.equal(replies[6].sessionId, 'S1');
    // Logged once for the whole connection rather than once per attempt.
    assert.equal(blocked.length, 1);

    // Everything else still goes through untouched.
    const allowed = [
      { id: 20, method: 'Page.navigate', params: { url: 'https://example.com/' } },
      { id: 21, method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
      { id: 22, method: 'Browser.setDownloadBehavior', params: { behavior: 'deny' } },
      { id: 23, method: 'Page.setDownloadBehavior', params: { behavior: 'default' } },
      { id: 24, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/tmp/veneer-downloads/sub' } },
    ];
    for (const command of allowed) client.send(JSON.stringify(command));
    await waitUntil(() => forwarded.length === allowed.length);
    assert.deepEqual(forwarded.map(command => command.id), allowed.map(command => command.id));
    assert.equal(replies.length, refused.length);
  } finally {
    client.terminate();
    for (const socket of [...upstream.clients, ...gateway.clients]) socket.terminate();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});

// The Pro server's viewer channel was written against the Docker backend, where
// every copy's downloads directory is mounted at /downloads inside its
// container. Native Chrome sees the real directory, so the command is retargeted
// instead of refused.
test('retargets the container download path at the profile downloads directory', { timeout: 3000 }, async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([once(upstream, 'listening'), once(gateway, 'listening')]);
  const forwarded = [];
  upstream.on('connection', socket => socket.on('message', data => forwarded.push(JSON.parse(data.toString()))));
  gateway.on('connection', client => relayCdp(client, () => `ws://127.0.0.1:${upstream.address().port}`, {
    downloadsDir: '/tmp/veneer-os-store/profile/downloads',
  }));
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}`);
  try {
    await once(client, 'open');
    client.send(JSON.stringify({
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/downloads', eventsEnabled: true },
    }));
    await waitUntil(() => forwarded.length === 1);
    assert.deepEqual(forwarded[0], {
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/tmp/veneer-os-store/profile/downloads', eventsEnabled: true },
    });
  } finally {
    client.terminate();
    for (const socket of [...upstream.clients, ...gateway.clients]) socket.terminate();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  }
});
