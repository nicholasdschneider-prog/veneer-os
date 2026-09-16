import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { isNewTabPageUrl, runViewerSession } from '../src/channels/cdpDesktop.js';

/**
 * The viewer's message switch, driven end to end against a fake Chrome: the
 * only way to see what a viewer message actually asks the DevTools protocol to
 * do. One socket plays Chrome and records every call; another carries the
 * viewer messages runViewerSession translates.
 */

interface CdpCall {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** close() waits for live sockets, and both ends of this test stay open. */
function shutdown(wss: WebSocketServer, ...sockets: WebSocket[]): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    });
}

const DEFAULT_TARGETS = [{ targetId: 'page-1', type: 'page', title: 'One', url: 'https://example.com/' }];

function resultFor(method: string, params: Record<string, any>, targetInfos = DEFAULT_TARGETS): Record<string, unknown> {
  switch (method) {
    case 'Target.getTargets':
      return { targetInfos };
    case 'Target.attachToTarget':
      return { sessionId: `session-${params.targetId}` };
    case 'Target.createTarget':
      return { targetId: 'page-new' };
    case 'Page.getLayoutMetrics':
      return { cssVisualViewport: { pageX: 12, pageY: 34, clientWidth: 1280, clientHeight: 800 } };
    default:
      // Screenshots included: no data means no frame, which keeps the test
      // about messages rather than pixels.
      return {};
  }
}

async function startFakeChrome(targetInfos = DEFAULT_TARGETS): Promise<{
  url: string;
  calls: CdpCall[];
  sendEvent: (event: Record<string, unknown>) => void;
}> {
  const calls: CdpCall[] = [];
  let browserSocket: WebSocket | null = null;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    browserSocket = socket;
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8'));
      calls.push({ method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
      socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result: resultFor(message.method, message.params ?? {}, targetInfos) }));
    });
  });
  cleanups.push(shutdown(wss));
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`,
    calls,
    sendEvent: (event) => browserSocket?.send(JSON.stringify(event)),
  };
}

/** A viewer at one end, the session's server-side socket at the other. */
async function connectViewer(
  cdpWebSocketUrl: string,
  options: {
    frameQuality?: number;
    frameScale?: number;
    frameLimits?: { maxPixels?: number; maxWidth?: number; maxHeight?: number };
    framePacing?: 'viewer' | 'latest';
  } = {},
): Promise<{ viewer: WebSocket }> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const sessionSocket = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const viewer = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}/`);
  await new Promise((resolve) => viewer.once('open', resolve));
  cleanups.push(shutdown(wss, viewer));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-desktop-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  await runViewerSession(await sessionSocket, {
    cdpWebSocketUrl,
    downloadDir: path.join(dir, 'downloads'),
    uploadDir: path.join(dir, 'uploads'),
    ...options,
  });
  return { viewer };
}

async function session(): Promise<{ send: (msg: Record<string, unknown>) => void; calls: CdpCall[]; viewer: WebSocket }> {
  const chrome = await startFakeChrome();
  const { viewer } = await connectViewer(chrome.url);
  // Everything the opening attach did; the assertions are about what follows.
  chrome.calls.length = 0;
  return { send: (msg) => viewer.send(JSON.stringify(msg)), calls: chrome.calls, viewer };
}

const find = (calls: CdpCall[], method: string): CdpCall | undefined => calls.find((call) => call.method === method);

describe('viewer newtab message', () => {
  it('creates a blank tab, activates it and attaches the screencast to it', async () => {
    const { send, calls } = await session();
    send({ t: 'newtab' });

    await vi.waitFor(() => expect(find(calls, 'Target.attachToTarget')).toBeTruthy());
    expect(find(calls, 'Target.createTarget')!.params).toEqual({ url: 'about:blank' });
    expect(find(calls, 'Target.activateTarget')!.params).toEqual({ targetId: 'page-new' });
    expect(find(calls, 'Target.attachToTarget')!.params).toMatchObject({ targetId: 'page-new' });
    // The new tab is in the strip, and it is the one being watched.
    expect(find(calls, 'Page.startScreencast')!.sessionId).toBe('session-page-new');
  });

  it('publishes the new tab to the viewer as the active one', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url);
    const targetLists: any[] = [];
    viewer.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.t === 'targets') targetLists.push(msg);
    });

    viewer.send(JSON.stringify({ t: 'newtab' }));
    await vi.waitFor(() => {
      const latest = targetLists.at(-1);
      expect(latest?.activeId).toBe('page-new');
      expect(latest.list).toContainEqual({ targetId: 'page-new', title: 'New Tab', url: 'about:blank' });
    });
  });
});

describe('viewer insert message', () => {
  it('inserts the whole clipboard string into the attached page', async () => {
    const { send, calls } = await session();
    send({ t: 'insert', text: 'hunter2 https://example.com/x' });

    await vi.waitFor(() => expect(find(calls, 'Input.insertText')).toBeTruthy());
    expect(find(calls, 'Input.insertText')!.params).toEqual({ text: 'hunter2 https://example.com/x' });
    expect(find(calls, 'Input.insertText')!.sessionId).toBe('session-page-1');
  });

  it('ignores a non-string, an oversized and an unknown message', async () => {
    const { send, calls } = await session();
    send({ t: 'insert', text: 42 });
    send({ t: 'insert' });
    send({ t: 'insert', text: 'x'.repeat(65_537) });
    send({ t: 'nonsense', text: 'hello' });
    // A message that does reach Chrome, sent last: once it lands, anything the
    // ignored ones would have sent has had its chance.
    send({ t: 'insert', text: 'ok' });

    await vi.waitFor(() => expect(find(calls, 'Input.insertText')).toBeTruthy());
    expect(calls.filter((call) => call.method === 'Input.insertText')).toHaveLength(1);
    expect(find(calls, 'Input.insertText')!.params).toEqual({ text: 'ok' });
  });

  it('accepts a paste right at the size limit', async () => {
    const { send, calls } = await session();
    send({ t: 'insert', text: 'y'.repeat(65_536) });

    await vi.waitFor(() => expect(find(calls, 'Input.insertText')).toBeTruthy());
    expect(find(calls, 'Input.insertText')!.params.text).toHaveLength(65_536);
  });
});

describe('Veneer Browser frame quality and agent cursor', () => {
  it('keeps the shared desktop at its legacy JPEG quality when no override is supplied', async () => {
    const chrome = await startFakeChrome();
    await connectViewer(chrome.url);
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.captureScreenshot')).toBeTruthy());
    expect(find(chrome.calls, 'Page.startScreencast')!.params.quality).toBe(60);
    expect(find(chrome.calls, 'Page.captureScreenshot')!.params.quality).toBe(60);
  });

  it('uses the requested JPEG quality for live frames and keyframes', async () => {
    const chrome = await startFakeChrome();
    await connectViewer(chrome.url, { frameQuality: 80 });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.captureScreenshot')).toBeTruthy());
    expect(find(chrome.calls, 'Page.startScreencast')!.params.quality).toBe(80);
    expect(find(chrome.calls, 'Page.captureScreenshot')!.params.quality).toBe(80);
  });

  it('uses a high-density bitmap while keeping the emulated viewport in CSS pixels', async () => {
    const chrome = await startFakeChrome();
    await connectViewer(chrome.url, { frameQuality: 80, frameScale: 1.5, frameLimits: { maxPixels: 4_200_000 } });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.captureScreenshot')).toBeTruthy());
    expect(find(chrome.calls, 'Emulation.setDeviceMetricsOverride')!.params).toEqual({
      width: 1280,
      height: 800,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    expect(find(chrome.calls, 'Page.startScreencast')!.params).toMatchObject({ maxWidth: 1920, maxHeight: 1200 });
    expect(find(chrome.calls, 'Page.captureScreenshot')!.params).not.toHaveProperty('clip');
  });

  it('downscales thumbnail screencasts and keyframes without changing CSS coordinates', async () => {
    const chrome = await startFakeChrome();
    await connectViewer(chrome.url, {
      frameQuality: 80,
      frameScale: 1,
      frameLimits: { maxPixels: 360 * 240, maxWidth: 360, maxHeight: 240 },
    });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.captureScreenshot')).toBeTruthy());
    expect(find(chrome.calls, 'Emulation.setDeviceMetricsOverride')!.params.deviceScaleFactor).toBe(1);
    expect(find(chrome.calls, 'Page.startScreencast')!.params).toMatchObject({ maxWidth: 360, maxHeight: 225 });
    expect(find(chrome.calls, 'Page.captureScreenshot')!.params.clip).toEqual({
      x: 12,
      y: 34,
      width: 1280,
      height: 800,
      scale: 0.28125,
    });
  });

  it('follows the agent to another tab and publishes it as active', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url);
    const published: any[] = [];
    viewer.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString('utf8'));
      if (message.t === 'targets') published.push(message);
    });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.startScreencast')).toBeTruthy());

    chrome.sendEvent({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: 'page-2', type: 'page', title: 'Two', url: 'https://example.org/' } },
    });
    chrome.sendEvent({ method: 'Veneer.agentTarget', params: { targetId: 'page-2' } });
    // Not a page the viewer knows and Chrome does not list it: ignored.
    chrome.sendEvent({ method: 'Veneer.agentTarget', params: { targetId: 'page-nowhere' } });

    await vi.waitFor(() =>
      expect(chrome.calls.filter((c) => c.method === 'Target.attachToTarget').map((c) => c.params.targetId)).toEqual([
        'page-1',
        'page-2',
      ]),
    );
    await vi.waitFor(() => expect(published.at(-1)?.activeId).toBe('page-2'));
    expect(find(chrome.calls, 'Page.bringToFront', 'session-page-2')).toBeTruthy();
  });

  it('relays cursor activity only for the target the viewer is watching', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url);
    const cursors: any[] = [];
    viewer.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString('utf8'));
      if (message.t === 'agent-cursor') cursors.push(message);
    });

    chrome.sendEvent({
      method: 'Veneer.agentCursor',
      params: { type: 'mousePressed', x: 4, y: 5, targetId: 'other-page' },
    });
    chrome.sendEvent({
      method: 'Veneer.agentCursor',
      params: { type: 'mousePressed', x: 40, y: 50, targetId: 'page-1' },
    });
    await vi.waitFor(() => expect(cursors).toHaveLength(1));
    expect(cursors[0]).toEqual({
      t: 'agent-cursor', type: 'mousePressed', x: 40, y: 50,
    });
  });
});

describe('New Tab page handling', () => {
  it('recognises both New Tab page URLs and nothing else', () => {
    expect(isNewTabPageUrl('chrome://newtab/')).toBe(true);
    expect(isNewTabPageUrl('chrome://newtab')).toBe(true);
    expect(isNewTabPageUrl('chrome://new-tab-page/')).toBe(true);
    expect(isNewTabPageUrl('chrome://new-tab-page-third-party/')).toBe(true);
    expect(isNewTabPageUrl('about:blank')).toBe(false);
    expect(isNewTabPageUrl('https://example.com/chrome://newtab')).toBe(false);
    expect(isNewTabPageUrl(undefined)).toBe(false);
  });

  it('sends a fresh browser from the New Tab page to about:blank on attach', async () => {
    const chrome = await startFakeChrome([{ targetId: 'page-ntp', type: 'page', title: 'New Tab', url: 'chrome://newtab/' }]);
    await connectViewer(chrome.url);
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.startScreencast')).toBeTruthy());
    const navigate = find(chrome.calls, 'Page.navigate');
    expect(navigate?.params).toEqual({ url: 'about:blank' });
    expect(navigate?.sessionId).toBe('session-page-ntp');
    // The page is still listed: it is the human's tab, just not on Chrome's start page.
    expect(find(chrome.calls, 'Target.closeTarget')).toBeUndefined();
  });

  it('leaves an ordinary page where it is', async () => {
    const { calls } = await session();
    expect(find(calls, 'Page.navigate')).toBeUndefined();
  });
});

describe('frame metrics', () => {
  it('republishes the viewport when a frame reports a different CSS size, once per change', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url);
    const metrics: any[] = [];
    viewer.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString('utf8'));
      if (message.t === 'metrics') metrics.push(message);
    });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.startScreencast')).toBeTruthy());
    const frame = (w: number, h: number, id: number) =>
      chrome.sendEvent({
        method: 'Page.screencastFrame',
        sessionId: 'session-page-1',
        params: { data: Buffer.from('jpeg').toString('base64'), sessionId: id, metadata: { deviceWidth: w, deviceHeight: h } },
      });
    // A page that ignored emulation renders at the screen size.
    frame(1440, 1000, 1);
    await vi.waitFor(() => expect(metrics.at(-1)).toMatchObject({ w: 1440, h: 1000 }));
    const count = metrics.length;
    frame(1440, 1000, 2);
    frame(1440, 1000, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(metrics.length).toBe(count);
    // Back on an ordinary page the emulated size returns.
    frame(1280, 800, 4);
    await vi.waitFor(() => expect(metrics.at(-1)).toMatchObject({ w: 1280, h: 800 }));
  });
});

describe('idle-page keyframe', () => {
  it('captures a keyframe on attach and retries once when nothing streams', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url, { framePacing: 'latest' });
    void viewer;
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.captureScreenshot')).toBeTruthy());
    // The attach keyframe uses the current surface so an idle page cannot hang it.
    const shot = chrome.calls.find((c) => c.method === 'Page.captureScreenshot');
    expect(shot?.params.fromSurface).toBe(true);
    // Nothing streamed on its own, so a second keyframe follows within the window.
    await vi.waitFor(
      () => expect(chrome.calls.filter((c) => c.method === 'Page.captureScreenshot').length).toBeGreaterThanOrEqual(2),
      { timeout: 2000 },
    );
  });
});

describe('frame delivery pacing', () => {
  it('acks Chrome at once and streams consecutive frames without waiting for the viewer', async () => {
    const chrome = await startFakeChrome();
    const { viewer } = await connectViewer(chrome.url, { framePacing: 'latest' });
    const frames: Buffer[] = [];
    viewer.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) frames.push(raw);
    });
    await vi.waitFor(() => expect(find(chrome.calls, 'Page.startScreencast')).toBeTruthy());
    chrome.calls.length = 0;

    const frame = (id: number, label: string) =>
      chrome.sendEvent({
        method: 'Page.screencastFrame',
        sessionId: 'session-page-1',
        params: { data: Buffer.from(label).toString('base64'), sessionId: id, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
      });
    frame(1, 'first');
    frame(2, 'second');

    // Chrome is released for both frames before the viewer has acknowledged anything.
    await vi.waitFor(() =>
      expect(chrome.calls.filter((c) => c.method === 'Page.screencastFrameAck').map((c) => c.params.sessionId)).toEqual([1, 2]),
    );
    // And both pictures reached the viewer with no ack in between.
    await vi.waitFor(() => expect(frames.map((f) => f.toString())).toEqual(['first', 'second']));
  });
});
