import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { VIRTUAL_AUTHENTICATOR, blockPasskeys, browserSocketUrl, passkeysAllowed } from './webauthn.mjs';

// A stand-in for Chrome's browser target: answers every command, and lets a
// test push Target.attachedToTarget events the way Chrome does for auto-attach.
let server;
let wss;
let port;
const sockets = new Set();
let commands = [];

function fakeChrome(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    commands.push(message);
    socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: message.method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'virtual-1' } : {} }));
  });
}

function attach(socket, sessionId, waitingForDebugger) {
  socket.send(JSON.stringify({
    method: 'Target.attachedToTarget',
    params: { sessionId, waitingForDebugger, targetInfo: { type: 'page', url: 'https://example.com/' } },
  }));
}

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out; commands so far: ${JSON.stringify(commands)}`);
}

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Chrome/fake', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id` }));
  });
  wss = new WebSocketServer({ server, path: '/devtools/browser/fake-id' });
  wss.on('connection', fakeChrome);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  wss.close();
  await new Promise((resolve) => server.close(resolve));
});

test('passkeys are blocked unless the opt-out env is set', () => {
  assert.equal(passkeysAllowed({}), false);
  assert.equal(passkeysAllowed({ VP_BROWSER_ALLOW_PASSKEYS: '0' }), false);
  assert.equal(passkeysAllowed({ VP_BROWSER_ALLOW_PASSKEYS: '1' }), true);
  assert.equal(passkeysAllowed({ VENEER_BROWSER_ALLOW_PASSKEYS: '1' }), true);
});

test('the virtual authenticator can never satisfy a passkey prompt', () => {
  assert.equal(VIRTUAL_AUTHENTICATOR.hasUserVerification, false);
  assert.equal(VIRTUAL_AUTHENTICATOR.isUserVerified, false);
  assert.equal(VIRTUAL_AUTHENTICATOR.transport, 'internal');
});

test('resolves the browser socket from /json/version on the loopback port', async () => {
  assert.equal(await browserSocketUrl(port), `ws://127.0.0.1:${port}/devtools/browser/fake-id`);
});

test('auto-attaches to pages and installs an empty virtual authenticator on each, then releases it', async () => {
  commands = [];
  const handle = blockPasskeys(await browserSocketUrl(port));
  await handle.ready;
  const autoAttach = commands.find((command) => command.method === 'Target.setAutoAttach');
  assert.deepEqual(autoAttach.params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: 'page', exclude: false }],
  });
  assert.equal(sockets.size, 1);
  const [chrome] = sockets;

  // The tab that already existed when the block was installed.
  attach(chrome, 'session-1', false);
  await until(() => commands.some((c) => c.method === 'WebAuthn.addVirtualAuthenticator' && c.sessionId === 'session-1'));
  const first = commands.filter((c) => c.sessionId === 'session-1').map((c) => c.method);
  assert.deepEqual(first, ['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator']);
  const enable = commands.find((c) => c.method === 'WebAuthn.enable' && c.sessionId === 'session-1');
  assert.deepEqual(enable.params, { enableUI: false });
  const add = commands.find((c) => c.method === 'WebAuthn.addVirtualAuthenticator' && c.sessionId === 'session-1');
  assert.deepEqual(add.params, { options: { ...VIRTUAL_AUTHENTICATOR } });

  // A tab the agent opens later is held until the authenticator is in place.
  attach(chrome, 'session-2', true);
  await until(() => commands.some((c) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'session-2'));
  const second = commands.filter((c) => c.sessionId === 'session-2').map((c) => c.method);
  assert.deepEqual(second, ['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator', 'Runtime.runIfWaitingForDebugger']);

  assert.equal(handle.closed, false);
  handle.close();
  assert.equal(await handle.done, 'stopped');
  assert.equal(handle.closed, true);
  await until(() => sockets.size === 0);
});

test('a page that refuses the authenticator is still released', async () => {
  commands = [];
  const handle = blockPasskeys(await browserSocketUrl(port), { log: () => {} });
  await handle.ready;
  const [chrome] = sockets;
  chrome.removeAllListeners('message');
  chrome.on('message', (data) => {
    const message = JSON.parse(data.toString());
    commands.push(message);
    if (message.method === 'WebAuthn.enable') {
      chrome.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error: { code: -32601, message: 'no WebAuthn here' } }));
    } else {
      chrome.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: {} }));
    }
  });
  attach(chrome, 'session-3', true);
  await until(() => commands.some((c) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'session-3'));
  assert.equal(commands.some((c) => c.method === 'WebAuthn.addVirtualAuthenticator' && c.sessionId === 'session-3'), false);
  handle.close();
  await handle.done;
});

test('reports a socket that closes underneath it', async () => {
  const handle = blockPasskeys(await browserSocketUrl(port));
  await handle.ready;
  for (const socket of sockets) socket.close();
  assert.equal(await handle.done, 'closed');
  assert.equal(handle.closed, true);
});
