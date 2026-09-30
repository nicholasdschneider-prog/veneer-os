import { reconnectVeneerBrowserController, veneerBrowserSessionName, runAgentBrowser } from '../src/mcp/agentBrowser.js';
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

  it('cuts only controller sockets before shutdown, preserving upstream and independent preview with no CDP close or replay', async () => {
    const options={conversationId:'recovery-fixture',remoteSessionId:'clone-fixture',workspaceDir:dir};
    const session=veneerBrowserSessionName(options.conversationId,options.remoteSessionId);
    const url=await pinnedCdpAddress(session,target,ca);
    const messages:string[]=[];
    const observe=(socket:WebSocket)=>socket.on('message',data=>messages.push(data.toString()));
    wss.on('connection',observe);
    const controller=new WebSocket(url);
    const preview=new WebSocket(target,{ca:fs.readFileSync(ca)});
    await Promise.all([controller,preview].map(socket=>new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);} )));
    const old={bin:process.env.VP_AGENT_BROWSER_BIN,config:process.env.VP_AGENT_BROWSER_CONFIG};
    const binary=path.join(dir,'controller-stub');
    const config=path.join(dir,'controller-config.json');
    // The shutdown stub tries to reconnect to its only known controller endpoint.
    // The bridge must already be unreachable before this process is spawned; no CDP command can cross it.
    fs.writeFileSync(binary,`#!${process.execPath}
const net=require('node:net');const s=net.connect(${new URL(url).port},'127.0.0.1');s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));`,{mode:0o700});
    fs.writeFileSync(config,'{}');
    process.env.VP_AGENT_BROWSER_BIN=binary;process.env.VP_AGENT_BROWSER_CONFIG=config;
    try {
      const disconnected=new Promise<void>(resolve=>controller.once('close',()=>resolve()));
      await reconnectVeneerBrowserController(options);await disconnected;
      expect(messages).toEqual([]);
      expect(preview.readyState).toBe(WebSocket.OPEN);
      expect(server.listening).toBe(true);
      await rejected(url);
      await expect(runAgentBrowser(['click','@e1'],{...options,remoteCdpUrl:target,trustedCdpOrigin:target,cdpCaFile:ca})).rejects.toThrow('fresh snapshot');
      await expect(reconnectVeneerBrowserController(options)).rejects.toThrow('not proven');
    } finally {
      controller.terminate();preview.terminate();wss.off('connection',observe);closePinnedCdpBridge(session);
      if(old.bin===undefined)delete process.env.VP_AGENT_BROWSER_BIN;else process.env.VP_AGENT_BROWSER_BIN=old.bin;
      if(old.config===undefined)delete process.env.VP_AGENT_BROWSER_CONFIG;else process.env.VP_AGENT_BROWSER_CONFIG=old.config;
    }
  });

  it('quarantines failed shutdown without a new ticket, browser command or fallback', async () => {
    const options={conversationId:'failed-recovery-fixture',remoteSessionId:'failed-clone',workspaceDir:dir};
    const session=veneerBrowserSessionName(options.conversationId,options.remoteSessionId);
    const url=await pinnedCdpAddress(session,target,ca);
    const old={bin:process.env.VP_AGENT_BROWSER_BIN,config:process.env.VP_AGENT_BROWSER_CONFIG};
    const binary=path.join(dir,'failed-controller-stub');const config=path.join(dir,'failed-config.json');
    fs.writeFileSync(binary,'#!/bin/sh\nexit 1\n',{mode:0o700});fs.writeFileSync(config,'{}');
    process.env.VP_AGENT_BROWSER_BIN=binary;process.env.VP_AGENT_BROWSER_CONFIG=config;
    try {
      await expect(reconnectVeneerBrowserController(options)).rejects.toThrow('shutdown outcome unknown');
      await rejected(url);
      await expect(runAgentBrowser(['snapshot'],{...options,remoteCdpUrl:target,trustedCdpOrigin:target,cdpCaFile:ca})).rejects.toThrow('recovery is incomplete');
      expect(server.listening).toBe(true);
    } finally {
      closePinnedCdpBridge(session);
      if(old.bin===undefined)delete process.env.VP_AGENT_BROWSER_BIN;else process.env.VP_AGENT_BROWSER_BIN=old.bin;
      if(old.config===undefined)delete process.env.VP_AGENT_BROWSER_CONFIG;else process.env.VP_AGENT_BROWSER_CONFIG=old.config;
    }
  });

  it('refuses plaintext upstreams', async () => {
    await expect(pinnedCdpAddress('plain', target.replace('wss:', 'ws:'), ca)).rejects.toThrow('WSS');
  });
});
