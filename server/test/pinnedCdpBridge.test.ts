import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { closePinnedCdpBridge, pinnedCdpAddress } from '../src/veneerBrowser/pinnedCdpBridge.js';

describe('pinned CDP adapter', () => {
  let dir: string;
  let ca: string;
  let target: string;
  let server: https.Server;
  let wss: WebSocketServer;
  const sessions = ['echo', 'wrong-ca', 'origin', 'path', 'rotate', 'plain', 'hostname'];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-pin-test-'));
    ca = path.join(dir, 'cert.pem');
    // Ephemeral test credentials, never logged or used outside the fixture.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'key.pem'), '-out', ca, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(dir, 'other-key.pem'), '-out', path.join(dir, 'other.pem'), '-days', '1',
      '-subj', '/CN=localhost'], { stdio: 'ignore' });
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(ca) });
    wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => socket.on('message', (data, binary) => socket.send(data, { binary })));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    target = `wss://localhost:${address.port}/cdp/fixture/ws`;
  });

  afterAll(async () => {
    sessions.forEach(closePinnedCdpBridge);
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rejected = (url: string, options: WebSocket.ClientOptions = {}): Promise<void> => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, ...options });
    socket.on('error', () => resolve());
    socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected authorized connection')); });
  });

  it('relays text and binary over a certificate-validated upstream and reuses its address', async () => {
    const url = await pinnedCdpAddress('echo', target, ca);
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(url).not.toContain('fixture');
    expect(await pinnedCdpAddress('echo', target, ca)).toBe(url);
    for (const binary of [false, true]) {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on('error', reject);
        socket.on('open', () => socket.send('fixture message', { binary }));
        socket.on('message', (data, isBinary) => {
          expect(data.toString()).toBe('fixture message');
          expect(isBinary).toBe(binary);
          socket.close(); resolve();
        });
      });
    }
  });

  it('rejects an unrelated certificate and wrong hostname', async () => {
    await rejected(await pinnedCdpAddress('wrong-ca', target, path.join(dir, 'other.pem')));
    await rejected(await pinnedCdpAddress('hostname', target.replace('localhost', '127.0.0.1'), ca));
  });

  it('rejects browser origins and unknown capabilities', async () => {
    const url = await pinnedCdpAddress('origin', target, ca);
    await rejected(url, { origin: 'https://untrusted.example' });
    await rejected(url.replace(/\/cdp\/[^/]+\//, '/cdp/wrong/'));
  });

  it('closes the old listener on ticket rotation and session teardown', async () => {
    const previous = await pinnedCdpAddress('rotate', target, ca);
    const next = await pinnedCdpAddress('rotate', target.replace('fixture', 'next'), ca);
    expect(next).not.toBe(previous);
    await rejected(previous);
    closePinnedCdpBridge('rotate');
    await rejected(next);
  });

  it('refuses plaintext upstreams', async () => {
    await expect(pinnedCdpAddress('plain', target.replace('wss:', 'ws:'), ca)).rejects.toThrow('WSS');
  });
});
