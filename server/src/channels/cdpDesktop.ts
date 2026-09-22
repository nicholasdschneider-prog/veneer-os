import { teachingProbe } from '../botWorkflows/teaching.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import { browserWebSocketUrl, connectCdp, type CdpConnection } from './cdpClient.js';
import { desktopUpgradeAllowed } from './desktopAuth.js';
import { createSerialQueue } from '../mcp/serialQueue.js';

/**
 * CDP screencast bridge at /ws/desktop — the portable replacement for the
 * VNC pipe. The server attaches to the shared Chrome over the DevTools protocol
 * on loopback, streams `Page.screencastFrame` JPEGs down to a canvas viewer, and
 * replays the viewer's mouse and keyboard back up with `Input.dispatch*`.
 *
 * This removes Xvfb, openbox, x11vnc and noVNC, and with them any need for a
 * login session, Screen Recording, or Accessibility permission — which is what
 * makes the desktop work on macOS at all.
 *
 * Same gate as the VNC path: full control of the user's browser, so active
 * owner/consultant only. NEVER log frame or input payloads (they are the user's
 * screen and keystrokes); lifecycle logs only.
 */

// Chrome renders the next frame only once the previous one is acked, so acking
// on the viewer's behalf is the whole backpressure story: a slow client simply
// receives fewer frames. This bounds how long one stuck viewer may stall the
// stream before we ack anyway and let Chrome carry on.
const ACK_TIMEOUT_MS = 2_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// Latest-frame pacing: frames stream freely until this much is queued in the
// socket, then only the newest waits. Roughly two large JPEG frames.
const FRAME_LOW_WATER_BYTES = 1024 * 1024;
const DEFAULT_FRAME_QUALITY = 60;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const TOUCH_SCROLL_REFRESH_DELAYS_MS = [350, 1_400] as const;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// A paste, not a document: enough for any realistic clipboard, small enough
// that a hostile viewer cannot hand Chrome an unbounded string.
const MAX_INSERT_CHARS = 65_536;
const AGENT_CURSOR_EVENT = 'Veneer.agentCursor';
// Emitted by the browser manager when the agent's commands move to another
// tab. The viewer follows, so the tab on screen is always the agent's.
const AGENT_TARGET_EVENT = 'Veneer.agentTarget';
// Chrome reads the file when the form is submitted, not when it is selected, so
// the copy has to outlive the picker by a sensible margin.
const UPLOAD_RETENTION_MS = 10 * 60 * 1000;

export interface FrameGeometry {
  deviceScaleFactor: number;
  maxWidth: number;
  maxHeight: number;
  captureScale: number;
}

/**
 * Keep page/input geometry in CSS pixels while bounding the physical bitmap.
 * Chrome may still need a 1x surface for a very large CSS viewport; in that
 * case only the encoded frame is downsampled to the requested pixel budget.
 */
export function cappedFrameGeometry(
  viewport: { width: number; height: number },
  requestedScale = 1,
  limits: { maxPixels?: number; maxWidth?: number; maxHeight?: number } = {},
): FrameGeometry {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const requested = Number.isFinite(requestedScale) ? Math.min(2, Math.max(1, requestedScale)) : 1;
  const maxPixels = Number.isFinite(limits.maxPixels) && limits.maxPixels! > 0 ? limits.maxPixels! : Infinity;
  const maxWidth = Number.isFinite(limits.maxWidth) && limits.maxWidth! > 0 ? limits.maxWidth! : Infinity;
  const maxHeight = Number.isFinite(limits.maxHeight) && limits.maxHeight! > 0 ? limits.maxHeight! : Infinity;
  const scaleByPixels = Math.sqrt(maxPixels / (width * height));
  const deviceScaleFactor = Math.max(1, Math.min(requested, scaleByPixels, maxWidth / width, maxHeight / height));
  const renderedWidth = width * deviceScaleFactor;
  const renderedHeight = height * deviceScaleFactor;
  const captureScale = Math.min(
    1,
    Math.sqrt(maxPixels / (renderedWidth * renderedHeight)),
    maxWidth / renderedWidth,
    maxHeight / renderedHeight,
  );
  return {
    deviceScaleFactor,
    maxWidth: Math.max(1, Math.floor(renderedWidth * captureScale)),
    maxHeight: Math.max(1, Math.floor(renderedHeight * captureScale)),
    captureScale,
  };
}

interface PageTarget {
  targetId: string;
  title: string;
  url: string;
}

export interface AgentCursorEvent {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
  x: number;
  y: number;
  targetId: string;
}

export function safeAgentCursorEvent(
  params: Record<string, any>,
  attachedTargetId: string | null,
): AgentCursorEvent | null {
  const type = String(params.type ?? '');
  const x = Number(params.x);
  const y = Number(params.y);
  const targetId = String(params.targetId ?? '');
  if (
    !['mouseMoved', 'mousePressed', 'mouseReleased'].includes(type) ||
    !targetId ||
    targetId !== attachedTargetId ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    Math.abs(x) > 100_000 ||
    Math.abs(y) > 100_000
  ) {
    return null;
  }
  return { type: type as AgentCursorEvent['type'], x, y, targetId };
}

export function adjacentTargetIdAfterClose(targetIds: string[], closingTargetId: string): string | null {
  const closingIndex = targetIds.indexOf(closingTargetId);
  if (closingIndex < 0) return null;
  return targetIds[closingIndex + 1] ?? targetIds[closingIndex - 1] ?? null;
}

export function isTouchScrollMessage(msg: Record<string, any>): boolean {
  return msg.t === 'mouse' && msg.type === 'mouseWheel' && msg.source === 'touch';
}

export function createTouchScrollRefreshScheduler(
  refresh: () => void,
  delays: readonly number[] = TOUCH_SCROLL_REFRESH_DELAYS_MS,
): { schedule: () => void; cancel: () => void } {
  let timers: NodeJS.Timeout[] = [];

  const cancel = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };

  return {
    schedule: () => {
      cancel();
      timers = delays.map((delay) => {
        const timer = setTimeout(refresh, delay);
        timer.unref();
        return timer;
      });
    },
    cancel,
  };
}

export interface LatestFramePump<T> {
  push(frame: T): void;
  acknowledge(): void;
  discardPending(): void;
  clear(): void;
}

/**
 * Deliver frames as fast as the socket will take them, and never let stale
 * pictures form a queue. While the socket is draining normally every frame
 * goes straight out; once its buffer backs up (a slow link, a tab in the
 * background) only the newest frame is kept, and it is released when the
 * viewer acknowledges the frame it just drew or the next frame finds the
 * socket ready. Waiting on the viewer's acknowledgement for *every* frame is
 * exactly what made the viewer lag: that acknowledgement crosses Cloudflare
 * twice, so the picture could never move faster than one frame per round trip.
 */
export function createLatestFramePump<T>(send: (frame: T) => void, ready: () => boolean = () => true): LatestFramePump<T> {
  let pending: { frame: T } | null = null;

  return {
    push(frame) {
      if (!ready()) {
        pending = { frame };
        return;
      }
      pending = null;
      send(frame);
    },
    acknowledge() {
      if (!pending || !ready()) return;
      const next = pending.frame;
      pending = null;
      send(next);
    },
    discardPending() {
      pending = null;
    },
    clear() {
      pending = null;
    },
  };
}

export function attachCdpDesktop(server: Server, ctx: AppContext): void {
  const cdpPort = ctx.config.desktopCdpPort;
  const downloadDir = path.join(ctx.config.dataDir, 'desktop-downloads');
  const uploadDir = path.join(ctx.config.dataDir, 'desktop-uploads');
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/desktop') return;
    socket.on('error', () => socket.destroy());
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      if (!desktopUpgradeAllowed(user)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket) => {
    // Connecting to Chrome is async, and the viewer sends its size the instant
    // it opens. Hold the socket until the session has its listeners, or that
    // first resize is read by nobody and the viewer renders at the wrong size.
    ws.pause();
    void runViewerSession(ws, { cdpPort, downloadDir, uploadDir }).catch((err: Error) => {
      sendJson(ws, { t: 'status', state: 'error', message: err.message });
      try {
        ws.close(1011);
      } catch {
        /* already closing */
      }
    });
  });
}

export interface ViewerOptions {
  teaching?: { active(): boolean; record(step: unknown): void };
  cdpPort?: number;
  cdpWebSocketUrl?: string;
  /** Pinned certificate when cdpWebSocketUrl is the browser VM's LAN address. */
  cdpCaFile?: string | null;
  downloadDir: string;
  /** The path belongs to Chrome's remote runtime and must not be created on this host. */
  remoteDownloadDir?: boolean;
  uploadDir: string;
  label?: string;
  /** Test mode: Chrome runs freely while the viewer receives only the newest frame. */
  framePacing?: 'viewer' | 'latest';
  /** JPEG quality for this viewer. Shared Agent Browser keeps its legacy default. */
  frameQuality?: number;
  /** Physical pixels per CSS pixel. Input and cursor coordinates stay in CSS pixels. */
  frameScale?: number;
  /** Output limits used by Veneer Browser; omitted for the legacy shared viewer. */
  frameLimits?: { maxPixels?: number; maxWidth?: number; maxHeight?: number };
}

export async function runViewerSession(ws: WebSocket, options: ViewerOptions): Promise<void> {
  const { downloadDir, uploadDir } = options;
  const frameQuality = Number.isInteger(options.frameQuality) && options.frameQuality! >= 0 && options.frameQuality! <= 100
    ? options.frameQuality!
    : DEFAULT_FRAME_QUALITY;
  const frameScale = Number.isFinite(options.frameScale) ? Math.min(2, Math.max(1, options.frameScale!)) : 1;
  let cdp: CdpConnection;
  try {
    const wsUrl = options.cdpWebSocketUrl ?? await browserWebSocketUrl(options.cdpPort ?? 9223);
    cdp = await connectCdp(wsUrl, { caFile: options.cdpCaFile });
  } catch (err) {
    // Chrome is down or still starting; its supervisor restarts it, and the
    // viewer reconnects on its own.
    throw new Error(`${options.label ?? 'shared browser'} unavailable: ${(err as Error).message}`);
  }
  console.log(`[veneer-pro] ${options.label ?? 'desktop'} viewer attached (cdp)`);

  let sessionId: string | null = null;
  let attachedTargetId: string | null = null;
  let viewport = { ...DEFAULT_VIEWPORT };
  // Chrome's frame ack id is an integer, and it silently ignores an ack of the
  // wrong type — which stalls the stream after exactly one frame.
  let pendingAck: number | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  const latestFrames = options.framePacing === 'latest'
    ? createLatestFramePump<Buffer>(
        (frame) => ws.send(frame, { binary: true }),
        // A couple of frames may sit in the socket before we start dropping.
        () => ws.bufferedAmount < FRAME_LOW_WATER_BYTES,
      )
    : null;
  const targets = new Map<string, PageTarget>();
  // Attaching, resizing and (re)starting the screencast are multi-step CDP
  // sequences that corrupt each other if they interleave — a stopScreencast
  // landing after the last startScreencast leaves a viewer with a frozen screen.
  // Everything that mutates the session goes through here, in arrival order.
  const sessionOps = createSerialQueue();
  // `Target.setDiscoverTargets` replays a targetCreated for every page that
  // already exists. Those are not popups, so auto-follow stays off until the
  // first attach has settled.
  let following = false;
  // The file input awaiting a selection, and the transfer feeding it.
  let pendingChooser: { backendNodeId: number; multiple: boolean } | null = null;
  let upload: { file: string; fd: number | null; bytes: number; failed: boolean } | null = null;
  // Chrome usually emits another screencast frame when a lazy image paints,
  // but headless screencasts can miss that late repaint. Touch swipes schedule
  // two bounded keyframes after they settle instead of capturing every wheel
  // event. The later frame covers slower image requests.
  const touchScrollRefresh = createTouchScrollRefreshScheduler(() => {
    const currentSession = sessionId;
    if (currentSession) void sendKeyframe(currentSession);
  });

  const teardown = (): void => {
    if (ackTimer) clearTimeout(ackTimer);
    if (keyframeRetry) clearTimeout(keyframeRetry);
    latestFrames?.clear();
    touchScrollRefresh.cancel();
    // Device emulation changes the shared target, but clearing it from one CDP
    // client can disrupt another viewer or an agent attached to the same page.
    // A later attach/resize always reapplies its complete metrics, and the
    // short-lived browser container clears the final override at shutdown.
    cdp.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  };

  cdp.onClose(() => {
    sendJson(ws, { t: 'status', state: 'disconnected', message: 'The shared browser went away.' });
    teardown();
  });
  ws.on('close', teardown);
  ws.on('error', teardown);

  // ── Frame pump ────────────────────────────────────────────────────────────
  function ackChrome(): void {
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
    const frameId = pendingAck;
    pendingAck = null;
    if (frameId !== null && sessionId) cdp.post('Page.screencastFrameAck', { sessionId: frameId }, sessionId);
  }

  // The frame's own CSS size is the truth the viewer must map clicks against.
  // It normally equals the emulated viewport, but a page that ignores emulation
  // (Chrome WebUI, for one) renders at the screen size instead, and clicks
  // scaled to the wrong size land nowhere near the tap.
  let publishedMetrics: { w: number; h: number } | null = null;
  // Whether a real screencast frame has streamed since the last (re)attach, and
  // the fallback-keyframe timer for an idle page that never repaints.
  let sawScreencastFrame = false;
  let keyframeRetry: NodeJS.Timeout | null = null;
  function publishFrameMetrics(metadata: Record<string, unknown> | undefined): void {
    const w = Math.round(Number(metadata?.deviceWidth));
    const h = Math.round(Number(metadata?.deviceHeight));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    if (publishedMetrics && publishedMetrics.w === w && publishedMetrics.h === h) return;
    publishedMetrics = { w, h };
    const frame = cappedFrameGeometry(viewport, frameScale, options.frameLimits);
    sendJson(ws, { t: 'metrics', w, h, scale: frame.deviceScaleFactor });
  }

  function sendFrame(frame: Buffer): void {
    if (latestFrames) latestFrames.push(frame);
    else ws.send(frame, { binary: true });
  }

  cdp.on((event) => {
    if (event.method === AGENT_CURSOR_EVENT) {
      const cursor = safeAgentCursorEvent(event.params, attachedTargetId);
      if (cursor) sendJson(ws, { t: 'agent-cursor', type: cursor.type, x: cursor.x, y: cursor.y });
      return;
    }
    if (event.method === AGENT_TARGET_EVENT) {
      followAgentTarget(String(event.params?.targetId ?? ''));
      return;
    }
    if (event.sessionId && event.sessionId !== sessionId) return;
    if (event.method === 'Page.screencastFrame') {
      sawScreencastFrame = true;
      const frameId = Number(event.params.sessionId);
      if (ws.readyState !== WebSocket.OPEN) {
        if (sessionId) cdp.post('Page.screencastFrameAck', { sessionId: frameId }, sessionId);
        return;
      }
      const frame = Buffer.from(String(event.params.data), 'base64');
      publishFrameMetrics(event.params.metadata);
      if (latestFrames) {
        // The browser VM no longer waits for the image to travel to the human
        // viewer and back. Viewer acknowledgements pace only the bounded
        // one-in-flight plus one-latest delivery queue below.
        if (sessionId) cdp.post('Page.screencastFrameAck', { sessionId: frameId }, sessionId);
        sendFrame(frame);
        return;
      }
      // A viewer that has stopped draining gets no new frames until it catches
      // up; ack Chrome immediately so the page itself never stalls.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (sessionId) cdp.post('Page.screencastFrameAck', { sessionId: frameId }, sessionId);
        return;
      }
      pendingAck = frameId;
      sendFrame(frame);
      ackTimer = setTimeout(ackChrome, ACK_TIMEOUT_MS);
      ackTimer.unref();
      return;
    }
    if (event.method === 'Page.frameNavigated' || event.method === 'Page.navigatedWithinDocument') {
      // The tab list only moves when Chrome gets round to a targetInfoChanged,
      // which is too late for an address bar. Push the main frame's URL as soon
      // as the page commits to it.
      const url =
        event.method === 'Page.navigatedWithinDocument'
          ? String(event.params.url ?? '')
          : event.params.frame?.parentId
            ? ''
            : String(event.params.frame?.url ?? '');
      if (url) sendJson(ws, { t: 'url', url });
      return;
    }
    if (event.method === 'Page.fileChooserOpened') {
      // Interception is on, so no native dialog appeared — headless has none,
      // and on a Mac one would need a login session. Hand the picker to the
      // viewer instead and feed the chosen bytes back with DOM.setFileInputFiles.
      pendingChooser = {
        backendNodeId: Number(event.params.backendNodeId),
        multiple: event.params.mode === 'selectMultiple',
      };
      sendJson(ws, { t: 'filechooser', multiple: pendingChooser.multiple });
      return;
    }
    if (event.method === 'Inspector.detached' || event.method === 'Target.detachedFromTarget') {
      if (event.method === 'Target.detachedFromTarget' && event.params.sessionId !== sessionId) return;
      // The page we were watching closed. Follow whatever is left.
      void sessionOps.run(() => followBestTarget()).catch(() => teardown());
      return;
    }
    if (
      event.method === 'Target.targetCreated' ||
      event.method === 'Target.targetInfoChanged' ||
      event.method === 'Target.targetDestroyed'
    ) {
      handleTargetEvent(event.method, event.params);
    }
  });

  function handleTargetEvent(method: string, params: Record<string, any>): void {
    if (method === 'Target.targetDestroyed') {
      targets.delete(String(params.targetId));
      publishTargets();
      if (params.targetId === attachedTargetId) {
        void sessionOps.run(() => followBestTarget()).catch(() => teardown());
      }
      return;
    }
    const info = params.targetInfo as { targetId: string; type: string; title: string; url: string } | undefined;
    if (!info || info.type !== 'page' || isInternalUrl(info.url)) return;
    const known = targets.has(info.targetId);
    targets.set(info.targetId, { targetId: info.targetId, title: info.title, url: info.url });
    publishTargets();
    // A popup or a link opening a new tab is what the human wants to look at.
    if (following && !known && method === 'Target.targetCreated' && attachedTargetId !== info.targetId) {
      void sessionOps.run(() => attachTo(info.targetId)).catch(() => {
        /* keep watching the current page */
      });
    }
  }

  // A human click elsewhere is fine; the agent's next action on a different
  // tab pulls the viewer back. Unknown ids are re-checked once against Chrome
  // because the agent can act on a tab before its targetCreated arrives.
  function followAgentTarget(targetId: string): void {
    if (!targetId || targetId === attachedTargetId) return;
    void sessionOps
      .run(async () => {
        if (targetId === attachedTargetId) return;
        if (!targets.has(targetId)) await refreshTargets();
        if (!targets.has(targetId)) return;
        await attachTo(targetId);
      })
      .catch(() => {
        /* keep watching the current page */
      });
  }

  function publishTargets(): void {
    sendJson(ws, { t: 'targets', list: [...targets.values()], activeId: attachedTargetId });
  }

  // ── Target attachment ─────────────────────────────────────────────────────
  async function attachTo(targetId: string): Promise<void> {
    if (sessionId) {
      // Stop the old stream before switching, or Chrome keeps sending frames
      // from a page nobody is looking at.
      const previous = sessionId;
      cdp.post('Page.stopScreencast', {}, previous);
      // Clearing this first is what stops our own detach from looking like the
      // page disappearing — otherwise the detach handler re-attaches, detaches
      // again, and the session loops forever.
      sessionId = null;
      try {
        await cdp.send('Target.detachFromTarget', { sessionId: previous });
      } catch {
        /* the target may already be gone */
      }
    }
    if (ackTimer) clearTimeout(ackTimer);
    pendingAck = null;
    // Keep an already-sent frame in flight. WebSocket messages have no frame
    // id, so its later viewer acknowledgement must release the first frame
    // from the new target instead of being mistaken for that new frame's ack.
    latestFrames?.discardPending();

    const { sessionId: newSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = String(newSession);
    attachedTargetId = targetId;

    await cdp.send('Page.enable', {}, sessionId);
    // Chrome rasterizes only the foreground tab. A backgrounded one produces no
    // screencast frames at all, and Page.captureScreenshot on it blocks forever
    // waiting for a paint that never comes — so whatever the viewer is watching
    // must be brought to the front first. Page.bringToFront is the command that
    // actually does this under --headless=new; Target.activateTarget does not,
    // because there is no window manager to activate anything in.
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    // about:blank is an ordinary page, so the viewport applies and the address
    // bar (which turns bare text into a search) takes over from the New Tab page.
    if (isNewTabPageUrl(targets.get(targetId)?.url)) {
      await cdp.send('Page.navigate', { url: 'about:blank' }, sessionId).catch(() => {});
    }
    await applyViewport();
    // Downloads must never open a native dialog: headless has none, and on a
    // Mac a dialog would need a login session. Land them in Chrome's own
    // download dir and let the page carry on.
    // `allow` without a downloadPath is rejected outright, which would leave
    // downloads falling back to a native dialog Chrome cannot show.
    prepareDownloadDirectory(downloadDir, options.remoteDownloadDir);
    await cdp
      .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true }, sessionId)
      .catch(() => {
        /* older Chrome without the browser-level command */
      });
    // Same for file pickers: intercept so a click on <input type=file> resolves
    // instead of hanging on a chooser that can never appear.
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId).catch(() => {});
    // setFileInputFiles resolves a backendNodeId, which needs the DOM agent.
    await cdp.send('DOM.enable', {}, sessionId).catch(() => {});
    await startScreencast();
    publishTargets();
  }

  async function applyViewport(): Promise<void> {
    if (!sessionId) return;
    const frame = cappedFrameGeometry(viewport, frameScale, options.frameLimits);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: frame.deviceScaleFactor, mobile: false },
      sessionId,
    );
  }

  async function startScreencast(): Promise<void> {
    if (!sessionId) return;
    const frame = cappedFrameGeometry(viewport, frameScale, options.frameLimits);
    await cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: frameQuality,
        maxWidth: frame.maxWidth,
        maxHeight: frame.maxHeight,
      },
      sessionId,
    );
    publishedMetrics = { w: viewport.width, h: viewport.height };
    sendJson(ws, { t: 'metrics', w: viewport.width, h: viewport.height, scale: frame.deviceScaleFactor });
    // Chrome emits a screencast frame only when something repaints, so a viewer
    // that attaches to (or resizes) an idle page would stare at nothing until
    // the page happened to change. Push one screenshot so there is always a
    // current image; the screencast takes over from there.
    const forSession = sessionId;
    sawScreencastFrame = false;
    void sendKeyframe(forSession);
    // A page that is not repainting emits no screencast frame at all, so on an
    // idle (re)attach the immediate keyframe above is the only image the viewer
    // gets — and if that one capture came back empty, try once more shortly
    // after, only while nothing has streamed on its own.
    if (keyframeRetry) clearTimeout(keyframeRetry);
    keyframeRetry = setTimeout(() => {
      keyframeRetry = null;
      if (!sawScreencastFrame && forSession === sessionId) void sendKeyframe(forSession);
    }, 700);
    keyframeRetry.unref();
  }

  async function sendKeyframe(forSession: string): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const frame = cappedFrameGeometry(viewport, frameScale, options.frameLimits);
      let clip: Record<string, number> | undefined;
      if (frame.captureScale < 1) {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, forSession);
        const visual = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
        clip = {
          x: Number(visual.pageX) || 0,
          y: Number(visual.pageY) || 0,
          width: viewport.width,
          height: viewport.height,
          scale: frame.captureScale,
        };
      }
      // fromSurface captures whatever is currently composited, so it returns
      // for an idle page instead of blocking on a repaint that never comes.
      const shot = await cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: frameQuality, fromSurface: true, ...(clip ? { clip, captureBeyondViewport: false } : {}) },
        forSession,
      );
      // Drop it if we switched targets while the capture was in flight.
      if (shot?.data && forSession === sessionId && ws.readyState === WebSocket.OPEN) {
        sendFrame(Buffer.from(String(shot.data), 'base64'));
      }
    } catch {
      /* the next real frame will do */
    }
  }

  async function refreshTargets(): Promise<void> {
    const { targetInfos } = await cdp.send('Target.getTargets', {});
    targets.clear();
    for (const info of targetInfos as { targetId: string; type: string; title: string; url: string }[]) {
      if (info.type !== 'page' || isInternalUrl(info.url)) continue;
      targets.set(info.targetId, { targetId: info.targetId, title: info.title, url: info.url });
    }
  }

  async function followBestTarget(): Promise<void> {
    await refreshTargets();
    const next = [...targets.keys()].at(-1);
    if (!next) {
      sessionId = null;
      attachedTargetId = null;
      sendJson(ws, { t: 'status', state: 'idle', message: 'No page is open in the shared browser.' });
      publishTargets();
      return;
    }
    await attachTo(next);
  }

  // ── Viewer input ──────────────────────────────────────────────────────────
  // ── File upload ───────────────────────────────────────────────────────────
  // The viewer streams the chosen file as binary chunks between an
  // upload-start/upload-end pair; we land it in DATA_DIR and point the page's
  // file input at it. Bytes go to disk, never through a log line.
  async function finishUpload(cancelled: boolean): Promise<void> {
    const current = upload;
    upload = null;
    if (current?.fd !== null && current?.fd !== undefined) {
      try {
        fs.closeSync(current.fd);
      } catch {
        /* already closed */
      }
    }

    const chooser = pendingChooser;
    pendingChooser = null;
    if (!chooser || !sessionId) return;

    const files = !cancelled && current && !current.failed && current.bytes > 0 ? [current.file] : [];
    try {
      await cdp.send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId }, sessionId);
      sendJson(ws, { t: 'upload-done', ok: files.length > 0 });
    } catch (err) {
      sendJson(ws, { t: 'upload-done', ok: false, message: (err as Error).message });
    }
    // The page has the bytes now; keeping a copy of the user's file would be a
    // second, unmanaged store of their data.
    if (current?.file) {
      const dir = path.dirname(current.file);
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), UPLOAD_RETENTION_MS).unref();
    }
  }

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Upload payload chunk.
      if (!upload || upload.failed) return;
      upload.bytes += raw.length;
      if (upload.bytes > MAX_UPLOAD_BYTES) {
        upload.failed = true;
        sendJson(ws, { t: 'upload-done', ok: false, message: 'File exceeds the 100 MB upload limit.' });
        return;
      }
      try {
        if (upload.fd !== null) fs.writeSync(upload.fd, raw);
      } catch {
        upload.failed = true;
      }
      return;
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (options.teaching?.active() && sessionId && (
      (msg.t === 'mouse' && (msg.type === 'mousePressed' || msg.type === 'mouseWheel')) ||
      msg.t === 'insert' || (msg.t === 'key' && ['keyDown','rawKeyDown'].includes(String(msg.type))) || msg.t === 'navigate'
    )) {
      const action = msg.t === 'insert' || (msg.t === 'key' && !['Enter','Tab','Escape'].includes(String(msg.key))) ? 'input' : msg.t === 'mouse' ? (msg.type === 'mouseWheel' ? 'scroll' : 'click') : msg.t === 'navigate' ? 'navigate' : 'key';
      void cdp.send('Runtime.evaluate', { expression: teachingProbe(action, msg.t === 'mouse' ? Number(msg.x) : undefined, msg.t === 'mouse' ? Number(msg.y) : undefined), returnByValue: true }, sessionId)
        .then((result: any) => { if (result?.result?.value) options.teaching?.record(action === 'key' ? { ...result.result.value, target: `${String(msg.key)} on ${result.result.value.target ?? ''}` } : result.result.value); }).catch(() => {});
    }
    switch (msg.t) {
      case 'ack':
        if (latestFrames) latestFrames.acknowledge();
        else ackChrome();
        return;
      case 'upload-start': {
        if (!pendingChooser) return; // nothing is asking for a file
        // Synchronous on purpose. The chunks follow immediately, so opening
        // asynchronously would drop the first ones on the floor, and async
        // writes could land out of order and corrupt the file.
        try {
          // Uniqueness goes in the directory, never the filename: the page (and
          // whatever server it posts to) sees this basename, so an upload of
          // invoice.pdf must arrive as invoice.pdf.
          const dir = path.join(uploadDir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const file = path.join(dir, safeFileName(msg.name));
          upload = { file, fd: fs.openSync(file, 'w', 0o600), bytes: 0, failed: false };
        } catch {
          upload = { file: '', fd: null, bytes: 0, failed: true };
        }
        return;
      }
      case 'upload-end':
        void finishUpload(false);
        return;
      case 'upload-cancel':
        // Clear the input rather than leaving the page waiting on a chooser
        // that will never return.
        void finishUpload(true);
        return;
      case 'mouse':
        if (sessionId) cdp.post('Input.dispatchMouseEvent', translateMouseEvent(msg), sessionId);
        if (isTouchScrollMessage(msg)) touchScrollRefresh.schedule();
        return;
      case 'key':
        if (sessionId) cdp.post('Input.dispatchKeyEvent', translateKeyEvent(msg), sessionId);
        return;
      case 'insert':
        // A paste arrives as one string: replaying it as synthetic keystrokes
        // drops characters in fields that handle input atomically, and Chrome
        // has a command for exactly this.
        if (typeof msg.text !== 'string' || msg.text.length > MAX_INSERT_CHARS) return;
        if (sessionId) cdp.post('Input.insertText', { text: msg.text }, sessionId);
        return;
      case 'resize': {
        const width = clampDimension(msg.w, DEFAULT_VIEWPORT.width);
        const height = clampDimension(msg.h, DEFAULT_VIEWPORT.height);
        if (width === viewport.width && height === viewport.height) return;
        viewport = { width, height };
        void sessionOps
          .run(async () => {
            if (!sessionId) return; // picked up by the next attach
            await applyViewport();
            cdp.post('Page.stopScreencast', {}, sessionId);
            await startScreencast();
          })
          .catch(() => {
            /* a failed resize leaves the old size; not fatal */
          });
        return;
      }
      case 'navigate': {
        const url = safeNavigationUrl(msg.url);
        if (!url || !sessionId) return;
        void sessionOps
          .run(async () => {
            if (!sessionId) return;
            await cdp.send('Page.navigate', { url }, sessionId);
          })
          .catch(() => {
            /* a refused navigation leaves the page where it was */
          });
        return;
      }
      case 'reload':
        if (sessionId) cdp.post('Page.reload', {}, sessionId);
        return;
      case 'history': {
        if (!sessionId) return;
        const delta = Number(msg.delta) > 0 ? 1 : -1;
        void sessionOps
          .run(async () => {
            if (!sessionId) return;
            const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory', {}, sessionId);
            // Out of range is simply the end of the history: nothing to do.
            const entry = (entries as { id: number }[] | undefined)?.[Number(currentIndex) + delta];
            if (entry) await cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sessionId);
          })
          .catch(() => {
            /* no entry that way, or the page went away mid-step */
          });
        return;
      }
      case 'activate': {
        const targetId = String(msg.targetId ?? '');
        if (!targets.has(targetId) || targetId === attachedTargetId) return;
        void sessionOps
          .run(async () => {
            await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
            await attachTo(targetId);
          })
          .catch(() => {});
        return;
      }
      case 'newtab': {
        void sessionOps
          .run(async () => {
            // Same shape as the last-tab replacement below: auto-follow would
            // race the attach we are about to make ourselves, so it is off
            // until this new tab is the one being watched.
            const wasFollowing = following;
            following = false;
            try {
              const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
              const newTargetId = String(created.targetId ?? '');
              if (!newTargetId) return;
              targets.set(newTargetId, { targetId: newTargetId, title: 'New Tab', url: 'about:blank' });
              await cdp.send('Target.activateTarget', { targetId: newTargetId }).catch(() => {});
              await attachTo(newTargetId);
            } finally {
              following = wasFollowing;
            }
          })
          .catch(() => {
            /* a refused tab leaves the viewer on the page it had */
          });
        return;
      }
      case 'close': {
        const targetId = String(msg.targetId ?? '');
        if (!targets.has(targetId)) return;
        void sessionOps
          .run(async () => {
            if (!targets.has(targetId)) return;
            if (targetId === attachedTargetId) {
              const adjacentTargetId = adjacentTargetIdAfterClose([...targets.keys()], targetId);
              if (adjacentTargetId) {
                await cdp.send('Target.activateTarget', { targetId: adjacentTargetId }).catch(() => {});
                await attachTo(adjacentTargetId);
              } else {
                // Keep the embedded browser alive when its final tab closes.
                // Make the replacement before closing the current target so
                // Chrome never has a moment with no page to display.
                const wasFollowing = following;
                following = false;
                try {
                  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
                  const replacementId = String(created.targetId ?? '');
                  if (!replacementId) return;
                  targets.set(replacementId, { targetId: replacementId, title: 'New Tab', url: 'about:blank' });
                  await cdp.send('Target.activateTarget', { targetId: replacementId }).catch(() => {});
                  await attachTo(replacementId);
                } finally {
                  following = wasFollowing;
                }
              }
            }
            await cdp.send('Target.closeTarget', { targetId });
          })
          .catch(() => {});
        return;
      }
      default:
        return;
    }
  });

  // Listeners are in place; release the messages the viewer sent while we were
  // connecting (its opening resize among them).
  ws.resume();

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await sessionOps.run(() => followBestTarget());
  following = true;
  sendJson(ws, { t: 'status', state: 'connected' });
}

// ── Event translation ───────────────────────────────────────────────────────

const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);

function pressedMouseButton(buttons: number): string {
  if (buttons & 1) return 'left';
  if (buttons & 4) return 'middle';
  if (buttons & 2) return 'right';
  if (buttons & 8) return 'back';
  if (buttons & 16) return 'forward';
  return 'none';
}

export function translateMouseEvent(msg: Record<string, any>): Record<string, unknown> {
  const type = String(msg.type);
  const translatedType = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(type)
    ? type
    : 'mouseMoved';
  const buttons = Number(msg.buttons) || 0;
  const requestedButton = typeof msg.button === 'string' && MOUSE_BUTTONS.has(msg.button) ? msg.button : 'none';
  const event: Record<string, unknown> = {
    type: translatedType,
    x: Number(msg.x) || 0,
    y: Number(msg.y) || 0,
    modifiers: Number(msg.modifiers) || 0,
    // Chrome needs the held button on mouseMoved to drag its scrollbar thumb.
    button: translatedType === 'mouseMoved' ? pressedMouseButton(buttons) : requestedButton,
    buttons,
    clickCount: Number(msg.clickCount) || 0,
  };
  if (event.type === 'mouseWheel') {
    event.deltaX = Number(msg.deltaX) || 0;
    event.deltaY = Number(msg.deltaY) || 0;
  }
  return event;
}

export function translateKeyEvent(msg: Record<string, any>): Record<string, unknown> {
  const type = String(msg.type);
  const modifiers = Number(msg.modifiers) || 0;
  const event: Record<string, unknown> = {
    type: ['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(type) ? type : 'keyDown',
    modifiers,
    key: typeof msg.key === 'string' ? msg.key : undefined,
    code: typeof msg.code === 'string' ? msg.code : undefined,
    windowsVirtualKeyCode: Number(msg.keyCode) || undefined,
    nativeVirtualKeyCode: Number(msg.keyCode) || undefined,
  };
  // `text` is what actually types a character; without it a keyDown only moves
  // focus and modifies state.
  if (typeof msg.text === 'string' && msg.text.length > 0) {
    event.text = msg.text;
  } else if (event.type === 'keyDown' && msg.key === 'Enter' && (modifiers & 7) === 0) {
    // Chrome's keyboard layout represents both Enter keys as a carriage return.
    // Without it, CDP emits the DOM key events but skips native form submission.
    // Ctrl, Alt, and Meta suppress text, matching a physical keyboard shortcut.
    event.text = '\r';
    event.unmodifiedText = '\r';
  }
  return event;
}

function clampDimension(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(320, Math.min(3840, n));
}

/** Filenames come from the viewer, so never let one escape the upload dir. */
function safeFileName(value: unknown): string {
  const base = path.basename(String(value ?? 'upload')).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(0, 120) || 'upload';
}

/**
 * The address bar can send anything, so only ordinary web navigation gets
 * through: `javascript:` would run in whatever page is open, and `file:` would
 * read this host's disk through a browser the agents also drive.
 */
export function safeNavigationUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 4096) return null;
  if (raw === 'about:blank') return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/** Create only host-local download paths. A remote Chrome owns its own path. */
export function prepareDownloadDirectory(downloadDir: string, remote = false): void {
  if (!remote) fs.mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
}

function isInternalUrl(url: string): boolean {
  return url.startsWith('devtools://') || url.startsWith('chrome-extension://');
}

/**
 * Chrome's New Tab page is WebUI: it ignores the viewport emulation every other
 * page honours, so its screencast arrives at the Xvfb screen size while the
 * viewer maps clicks against the panel size, and nothing lands where it was
 * tapped. A fresh browser opens on exactly this page.
 */
export function isNewTabPageUrl(url: unknown): boolean {
  const value = String(url ?? '').toLowerCase();
  return value.startsWith('chrome://newtab') || value.startsWith('chrome://new-tab-page');
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* socket died mid-send */
  }
}
