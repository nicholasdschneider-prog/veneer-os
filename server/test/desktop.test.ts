import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { desktopUpgradeAllowed } from '../src/channels/desktop.js';
import {
  TOUCH_SCROLL_REFRESH_DELAYS_MS,
  adjacentTargetIdAfterClose,
  cappedFrameGeometry,
  createLatestFramePump,
  createTouchScrollRefreshScheduler,
  isTouchScrollMessage,
  prepareDownloadDirectory,
  safeAgentCursorEvent,
  safeNavigationUrl,
  translateKeyEvent,
  translateMouseEvent,
} from '../src/channels/cdpDesktop.js';
import { cdpDesktopPageHtml } from '../src/routes/cdpDesktopPage.js';
import { desktopWrapperHtml } from '../src/routes/desktopPage.js';
import type { UserRow } from '../src/db/db.js';

function user(over: Partial<UserRow>): UserRow {
  return {
    id: 1,
    email: 'x@example.com',
    display_name: 'X',
    role: 'owner',
    status: 'active',
    created_at: '2026-01-01',
    last_seen_at: null,
    ...over,
  };
}

// Full control of the user's browser → active owner/consultant only, mirroring
// the terminal upgrade gate.
describe('desktop upgrade gate', () => {
  it('allows an active owner', () => {
    expect(desktopUpgradeAllowed(user({ role: 'owner', status: 'active' }))).toBe(true);
  });

  it('allows an active consultant', () => {
    expect(desktopUpgradeAllowed(user({ role: 'consultant', status: 'active' }))).toBe(true);
  });

  it('rejects a member', () => {
    expect(desktopUpgradeAllowed(user({ role: 'member', status: 'active' }))).toBe(false);
  });

  it('rejects an inactive owner', () => {
    expect(desktopUpgradeAllowed(user({ role: 'owner', status: 'pending' }))).toBe(false);
    expect(desktopUpgradeAllowed(user({ role: 'owner', status: 'disabled' }))).toBe(false);
  });

  it('rejects a missing user (no identity)', () => {
    expect(desktopUpgradeAllowed(undefined)).toBe(false);
  });
});

describe('desktop viewer resolution hints', () => {
  it('reports DPR and thumbnail mode only for the Veneer Browser viewer', () => {
    const shared = cdpDesktopPageHtml();
    const veneer = cdpDesktopPageHtml({
      websocketPath: '/ws/veneer-browser?conversation=chat-1',
      reportViewerHints: true,
    });
    expect(shared).toContain('const reportViewerHints = false;');
    expect(veneer).toContain('const reportViewerHints = true;');
    expect(veneer).toContain("'viewer=' + (viewOnly ? 'thumbnail' : 'full')");
    expect(veneer).toContain('window.devicePixelRatio');
  });

  it('leaves the shared Agent Browser at its legacy 1x geometry', () => {
    expect(cappedFrameGeometry({ width: 1280, height: 800 })).toEqual({
      deviceScaleFactor: 1,
      maxWidth: 1280,
      maxHeight: 800,
      captureScale: 1,
    });
  });
});

// The address bar in the desktop viewer hands us raw text; the shared browser
// is fully privileged, so only ordinary web navigation may reach it.
describe('desktop address bar navigation', () => {
  it('accepts http and https', () => {
    expect(safeNavigationUrl('https://example.com')).toBe('https://example.com/');
    expect(safeNavigationUrl('http://localhost:3210/board')).toBe('http://localhost:3210/board');
  });

  it('accepts about:blank', () => {
    expect(safeNavigationUrl('about:blank')).toBe('about:blank');
  });

  it('rejects script, file and data URLs', () => {
    expect(safeNavigationUrl('javascript:alert(1)')).toBeNull();
    expect(safeNavigationUrl('file:///etc/passwd')).toBeNull();
    expect(safeNavigationUrl('data:text/html,<h1>hi</h1>')).toBeNull();
  });

  it('rejects empty, unparseable and oversized input', () => {
    expect(safeNavigationUrl('')).toBeNull();
    expect(safeNavigationUrl('   ')).toBeNull();
    expect(safeNavigationUrl(undefined)).toBeNull();
    expect(safeNavigationUrl('not a url')).toBeNull();
    expect(safeNavigationUrl('https://example.com/' + 'a'.repeat(5000))).toBeNull();
  });
});

describe('desktop download path ownership', () => {
  it('creates a local path but leaves a remote Chrome path alone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-download-'));
    const local = path.join(root, 'local');
    const remote = path.join(root, 'remote');

    prepareDownloadDirectory(local);
    prepareDownloadDirectory(remote, true);

    expect(fs.statSync(local).isDirectory()).toBe(true);
    expect(fs.existsSync(remote)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('latest frame pump', () => {
  it('streams every frame while the socket is draining, without waiting for acks', () => {
    const sent: string[] = [];
    const pump = createLatestFramePump<string>((frame) => sent.push(frame));

    pump.push('one');
    pump.push('two');
    pump.push('three');

    expect(sent).toEqual(['one', 'two', 'three']);
  });

  it('keeps only the newest frame while the socket is backed up and releases it on ack', () => {
    const sent: string[] = [];
    let ready = true;
    const pump = createLatestFramePump<string>((frame) => sent.push(frame), () => ready);

    pump.push('one');
    ready = false;
    pump.push('two');
    pump.push('three');
    expect(sent).toEqual(['one']);

    pump.acknowledge(); // still backed up: nothing moves
    expect(sent).toEqual(['one']);

    ready = true;
    pump.acknowledge();
    expect(sent).toEqual(['one', 'three']);
  });

  it('delivers the final waiting frame once the socket drains, even if the page stopped painting', () => {
    const sent: string[] = [];
    let ready = false;
    const pump = createLatestFramePump<string>((frame) => sent.push(frame), () => ready);

    pump.push('moving');
    pump.push('settled');
    ready = true;
    pump.push('next');
    expect(sent).toEqual(['next']);
    pump.acknowledge();
    expect(sent).toEqual(['next']);
  });

  it('clears waiting state during session cleanup', () => {
    const sent: string[] = [];
    let ready = false;
    const pump = createLatestFramePump<string>((frame) => sent.push(frame), () => ready);

    pump.push('old-waiting');
    pump.clear();
    ready = true;
    pump.acknowledge();
    pump.push('new-session');

    expect(sent).toEqual(['new-session']);
  });

  it('drops the waiting frame when a new browser target replaces it', () => {
    const sent: string[] = [];
    let ready = false;
    const pump = createLatestFramePump<string>((frame) => sent.push(frame), () => ready);

    pump.push('old-waiting');
    pump.discardPending();
    ready = true;
    pump.acknowledge();
    expect(sent).toEqual([]);
    pump.push('new-target');
    expect(sent).toEqual(['new-target']);
  });
});

describe('desktop mouse input translation', () => {
  it('keeps positive wheel deltas moving down in Chrome CSS pixels', () => {
    expect(translateMouseEvent({
      type: 'mouseWheel', x: 20, y: 30, button: 'none', buttons: 0, deltaX: 4, deltaY: 240,
    })).toMatchObject({
      type: 'mouseWheel', x: 20, y: 30, button: 'none', buttons: 0, deltaX: 4, deltaY: 240,
    });
  });

  it('preserves the held left button during movement and releases it on mouseup', () => {
    expect(translateMouseEvent({ type: 'mouseMoved', button: 'none', buttons: 1 })).toMatchObject({
      type: 'mouseMoved', button: 'left', buttons: 1,
    });
    expect(translateMouseEvent({ type: 'mouseReleased', button: 'left', buttons: 0 })).toMatchObject({
      type: 'mouseReleased', button: 'left', buttons: 0,
    });
  });
});

describe('desktop keyboard input translation', () => {
  it('gives Enter the carriage return Chrome needs for native form submission', () => {
    expect(translateKeyEvent({
      type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0,
    })).toMatchObject({
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r',
    });
    expect(translateKeyEvent({
      type: 'keyDown', key: 'Enter', code: 'NumpadEnter', keyCode: 13, modifiers: 0,
    })).toMatchObject({ text: '\r', unmodifiedText: '\r' });
  });

  it('does not add text to Enter keyup or other named keys', () => {
    expect(translateKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13 })).not.toHaveProperty('text');
    expect(translateKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', keyCode: 9 })).not.toHaveProperty('text');
  });

  it('preserves text and modified-shortcut behavior for other keyboard input', () => {
    expect(translateKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })).toHaveProperty('text', 'a');
    expect(translateKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 2 })).not.toHaveProperty('text');
    expect(translateKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 8 })).toHaveProperty('text', '\r');
  });
});

describe('agent cursor filtering', () => {
  it('accepts finite cursor events only for the tab being viewed', () => {
    expect(safeAgentCursorEvent({
      type: 'mousePressed', x: 20, y: 30, targetId: 'page-1',
    }, 'page-1')).toEqual({ type: 'mousePressed', x: 20, y: 30, targetId: 'page-1' });
    expect(safeAgentCursorEvent({
      type: 'mouseMoved', x: 20, y: 30, targetId: 'page-2',
    }, 'page-1')).toBeNull();
    expect(safeAgentCursorEvent({
      type: 'mouseMoved', x: Number.POSITIVE_INFINITY, y: 30, targetId: 'page-1',
    }, 'page-1')).toBeNull();
  });
});

describe('desktop tab close selection', () => {
  it('selects the tab on the right, then the tab on the left at the end', () => {
    expect(adjacentTargetIdAfterClose(['a', 'b', 'c'], 'b')).toBe('c');
    expect(adjacentTargetIdAfterClose(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('returns no replacement for the last or an unknown tab', () => {
    expect(adjacentTargetIdAfterClose(['a'], 'a')).toBeNull();
    expect(adjacentTargetIdAfterClose(['a'], 'missing')).toBeNull();
  });
});

describe('mobile desktop keyboard', () => {
  const html = cdpDesktopPageHtml();

  it('keeps every inline viewer script valid JavaScript', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts.length).toBe(2);
    for (const script of scripts) {
      expect(script).toBeTruthy();
      expect(() => new Function(script)).not.toThrow();
    }
  });

  // The viewer is a same-origin iframe of the app, so it reads the app's own
  // theme keys before the stylesheet rather than flashing the wrong palette.
  it('picks up the app theme before the stylesheet paints', () => {
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<style>'));
    expect(html).toContain("localStorage.getItem(key)");
    expect(html).toContain("read('vp-theme') === 'terminal'");
    expect(html).toContain("read('vp-color-mode')");
    expect(html).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(html).toContain("window.addEventListener('storage', apply)");
    expect(html).toContain('html.dark {');
  });

  it('provides an iOS-focusable input and clear mobile keyboard control', () => {
    expect(html).toContain('interactive-widget=resizes-content');
    expect(html).toContain('id="keyboard-toggle"');
    expect(html).toContain('aria-label="Open keyboard"');
    expect(html).toContain('id="mobile-keyboard-input"');
    expect(html).toContain('aria-label="Type in the remote browser"');
    expect(html).toContain('class="lucide lucide-keyboard"');
    expect(html).not.toContain('<span class="label">Keyboard</span>');
  });

  it('keeps the keyboard controls large and inside iPhone safe areas', () => {
    expect(html).toContain("#nav button::after { content: ''; position: absolute;");
    expect(html).toContain('width: 48px; height: 48px;');
    expect(html).toContain('#keyboard-close { flex: 0 0 48px; width: 48px; height: 48px;');
    expect(html).toContain('env(safe-area-inset-left)');
    expect(html).toContain('env(safe-area-inset-right)');
  });

  it('provides common remote keys and protects the remote viewport while typing', () => {
    for (const key of ['Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Enter']) {
      expect(html).toContain(`data-key="${key}"`);
    }
    expect(html).toContain('if (viewOnly || mobileKeyboardInputFocused) return;');
    expect(html).toContain("window.visualViewport.addEventListener('resize', syncViewerHeight)");
  });

  it('turns one-finger drags into remote scrolling and keeps short taps clickable', () => {
    expect(html).toContain("canvas.addEventListener('touchstart'");
    expect(html).toContain("canvas.addEventListener('touchmove'");
    expect(html).toContain("canvas.addEventListener('touchend'");
    expect(html).toContain("t: 'mouse', type: 'mouseWheel'");
    expect(html).toContain('deltaY: (touchGesture.lastY - touch.clientY) * scaleY');
    expect(html).toContain("source: 'touch'");
    expect(html).toContain("touchMouse('mousePressed', touch, 1)");
    expect(html).toContain("touchMouse('mouseReleased', touch, 0)");
    expect(html).toContain("canvas { touch-action: none; }");
  });

  it('keeps desktop wheel direction and mouse capture for remote scrollbar dragging', () => {
    expect(html).toContain("canvas.addEventListener('pointerdown'");
    expect(html).toContain("canvas.addEventListener('pointermove'");
    expect(html).toContain("canvas.addEventListener('pointerup'");
    expect(html).toContain('canvas.setPointerCapture(e.pointerId)');
    expect(html).toContain("(buttons & 1) return 'left'");
    expect(html).toContain('deltaY: e.deltaY * unit * scaleY');
    expect(html).not.toContain('deltaY: -e.deltaY');
  });

  it('debounces two bounded refresh frames after touch scrolling settles', () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn();
      const scheduler = createTouchScrollRefreshScheduler(refresh);

      scheduler.schedule();
      vi.advanceTimersByTime(200);
      scheduler.schedule();
      vi.advanceTimersByTime(TOUCH_SCROLL_REFRESH_DELAYS_MS[0] - 1);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(TOUCH_SCROLL_REFRESH_DELAYS_MS[1] - TOUCH_SCROLL_REFRESH_DELAYS_MS[0]);
      expect(refresh).toHaveBeenCalledTimes(2);

      scheduler.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes only for wheel input produced by a touch swipe', () => {
    expect(isTouchScrollMessage({ t: 'mouse', type: 'mouseWheel', source: 'touch' })).toBe(true);
    expect(isTouchScrollMessage({ t: 'mouse', type: 'mouseWheel' })).toBe(false);
    expect(isTouchScrollMessage({ t: 'mouse', type: 'mousePressed', source: 'touch' })).toBe(false);
  });

  it('renders smaller mobile browser text without iPhone focus zoom', () => {
    expect(html).toContain('id="url-shell"');
    expect(html).toContain('#url { width: 123.077%; font-size: 16px; transform: scale(0.8125); transform-origin: left center; }');
    expect(html).toContain('.tab-select { gap: 8px; font-size: 13px; }');
  });

  it('draws agent activity in a viewer-only cursor layer', () => {
    expect(html).toContain('id="agent-cursor"');
    expect(html).toContain("msg.t === 'agent-cursor'");
    expect(html).toContain("message.type !== 'mousePressed'");
    expect(html).toContain('agentCursor.x / viewportSize.w');
    expect(html).toContain('pointer-events: none');
    expect(html).toContain('transition: opacity 180ms ease');
    expect(html).toContain('activeId !== msg.activeId');
  });
});

describe('desktop Focus mode header', () => {
  const html = cdpDesktopPageHtml();

  it('keeps the agent summary and keyboard control in the browser row', () => {
    expect(html).toContain('<h1>Agent Browser</h1>');
    expect(html).toContain('id="agent-summary"');
    expect(html).toContain('Agents have browser access.');
    expect(html.indexOf('id="agent-summary"')).toBeLessThan(html.indexOf('id="keyboard-toggle"'));
  });

  it('has no pause control or paused-access state', () => {
    for (const text of ['Pause agent access', 'Resume agent access', 'Agents paused', '/api/desktop/access']) {
      expect(html).not.toContain(text);
    }
    expect(desktopWrapperHtml()).not.toContain('Pause agent access');
  });
});

describe('desktop browser tabs', () => {
  const html = cdpDesktopPageHtml();

  it('puts a browser-style tab strip above the address bar', () => {
    expect(html).toContain('id="tab-strip"');
    expect(html).toContain('id="tabs" role="tablist"');
    expect(html.indexOf('id="tabs" role="tablist"')).toBeLessThan(html.indexOf('id="nav"'));
    expect(html).toContain("selectButton.setAttribute('role', 'tab')");
    expect(html).toContain("selectButton.setAttribute('aria-selected', String(isActive))");
  });

  it('provides close controls and a full touch target', () => {
    expect(html).toContain("closeButton.className = 'tab-close'");
    expect(html).toContain("send({ t: 'close', targetId: target.targetId })");
    expect(html).toContain(".tab-close::after { content: ''; position: absolute;");
  });

  it('groups Back and Forward in the compact mobile tab strip', () => {
    expect(html).toContain('id="tab-back" type="button" title="Back" aria-label="Back"');
    expect(html).toContain('id="tab-forward" type="button" title="Forward" aria-label="Forward"');
    expect(html.indexOf('id="tab-forward"')).toBeGreaterThan(html.indexOf('id="tab-back"'));
    expect(html.indexOf('id="tab-forward"')).toBeLessThan(html.indexOf('id="tabs" role="tablist"'));
    expect(html).toContain("navControl('tab-back', { t: 'history', delta: -1 })");
    expect(html).toContain("navControl('tab-forward', { t: 'history', delta: 1 })");
    // Back stays in the address row on touch: the chat panel hides the strip.
    expect(html).toContain('#nav #forward { display: none; }');
    expect(html).not.toContain('#nav #back, #nav #forward { display: none; }');
  });

  it('opens a new tab from the strip and hands the address bar the keyboard', () => {
    expect(html).toContain('id="tab-new" type="button" title="New tab" aria-label="New tab"');
    // After the tab list, so it sits at the end of the strip and survives every
    // renderTabs() rebuild of #tabs.
    expect(html.indexOf('id="tab-new"')).toBeGreaterThan(html.indexOf('id="tabs" role="tablist"'));
    expect(html.indexOf('id="tab-new"')).toBeLessThan(html.indexOf('id="nav"'));
    expect(html).toContain("send({ t: 'newtab' })");
    expect(html).toContain('urlInput.focus()');
    // No tab list yet, no lone "+".
    expect(html).toContain('#tabs:empty + #tab-new { display: none; }');
    expect(html).toContain("#tab-new::after { content: ''; position: absolute;");
  });

  it('uses a pill tab whose active state is a ringed page-coloured chip', () => {
    expect(html).toContain('.tab.active { background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }');
    expect(html).toContain('padding: 0 6px 0 10px; border-radius: 8px;');
    // Only the active tab carries a close control, so an inactive tab is one
    // target: select it.
    expect(html).toContain('.tab-close { display: none;');
    expect(html).toContain('.tab.active .tab-close { display: grid; place-items: center; }');
    expect(html).toContain("favEl.className = 'tab-fav'");
  });

  it('lets the host draw the tabs and drive them over postMessage', () => {
    expect(html).toContain('body.hosttabs #tab-strip { display: none; }');
    expect(html).toContain("params.get('tabs') === 'off'");
    expect(html).toContain("source: 'veneer-browser-viewer', t: 'ready'");
    expect(html).toContain("source: 'veneer-browser-viewer', t: 'targets'");
    expect(html).toContain("event.data.source === 'veneer-browser-host'");
    expect(html).toContain('event.origin === hostOrigin');
    expect(html).toContain('window.parent.postMessage(msg, hostOrigin)');
    // A reconnect must not re-show the waiting text over the last painted frame.
    expect(html).toContain("if (!announcedFrame) setStatus('Waiting for the first frame")
    // The thumbnail never registers the bridge.
    expect(html).toContain('const hostBridge = !viewOnly && hostTabs && window.parent !== window;');
    // One newTab() for the strip button and the host message alike.
    expect(html).toContain("document.getElementById('tab-new').addEventListener('click', newTab)");
    expect(html).toContain("else if (data.t === 'newtab') newTab();");
  });

  // The chat panel overlays its own avatar/close/tab-count controls on top of
  // this address row, so the row has to reserve exactly the space they take.
  it('reserves the panel host controls their space in the address row', () => {
    expect(html).toContain("params.get('host')");
    expect(html).toContain("if (hostLayout === 'desktop') document.body.classList.add('host-desktop');");
    expect(html).toContain("else if (hostMobile) document.body.classList.add('host-mobile');");
    expect(html).toContain('body.host-desktop #nav { padding-right: 48px; }');
    expect(html).toContain('body.host-mobile #nav { padding-left: 50px; padding-right: 92px; }');
    // The touch media block sets a padding shorthand on #nav; the host rules
    // come after it so the reservation survives on a phone.
    expect(html.indexOf('body.host-desktop #nav { padding-right: 48px; }')).toBeGreaterThan(
      html.indexOf('#nav { gap: 2px; padding: 2px max(6px, env(safe-area-inset-right))'),
    );
    // The panel's active tab merges into this row: no top edge in desktop mode.
    expect(html).toContain('body.host-desktop #nav { border-top: 0; box-shadow: none; }');
    // Reload has no room next to the phone overlays; Back and the keyboard stay.
    expect(html).toContain('body.host-mobile #nav #reload { display: none; }');
    expect(html).not.toContain('body.host-mobile #nav #back { display: none; }');
    expect(html).not.toContain('body.host-mobile #nav #keyboard-toggle { display: none; }');
  });

  it('reads the phone omnibox as a page title over its host', () => {
    expect(html).toContain("activeTitle = active && active.title ? String(active.title) : '';");
    expect(html).toContain("const title = hostMobile && host ? pageTitle() : '';");
    expect(html).toContain("urlDisplay.classList.add('two-line')");
    expect(html).toContain("titleEl.className = 'omni-title'");
    expect(html).toContain("hostLine.className = 'omni-host'");
    expect(html).toContain('urlDisplay.append(titleEl, hostLine)');
    // No title (about:blank, a placeholder, the address echoed back) keeps
    // today's host-bold, path-muted single line.
    expect(html).toContain("if (!title || title === 'about:blank' || title === 'Untitled') return '';");
    expect(html).toContain("if (title === lastUrl) return '';");
    expect(html).toContain('#url-display b { font-weight: 500; color: var(--fg); }');
    // Both lines fit the 40px touch pill, and the title clears in a new tab.
    expect(html).toContain('color: var(--fg); font-size: 13px; font-weight: 500; line-height: 14px; }');
    expect(html).toContain('color: var(--muted-fg); font-size: 11px; line-height: 12px; }');
    expect(html).toContain('#url-shell { height: 40px; }');
    expect(html).toContain("activeTitle = '';\n    renderUrlDisplay('');");
    // Every tab list and every address change re-renders the overlay.
    expect(html).toContain('setActiveTitle(list);\n    refreshUrlDisplay();');
    expect(html).toContain('function refreshUrlDisplay() { renderUrlDisplay(lastUrl); }');
  });

  it('goes live on the agent dot while advanced capture is on', () => {
    expect(html).toContain("data.t === 'capture'");
    expect(html).toContain('body.capture .agent-dot { background: var(--live);');
    expect(html).toContain("Advanced capture on. The agent can read this browser's network traffic.");
  });
});

// Cmd/Ctrl-V has to stay the local browser's shortcut: preventing it killed the
// paste event, which left the remote page pasting the VM's empty clipboard.
describe('desktop clipboard paste', () => {
  const html = cdpDesktopPageHtml();

  it('lets the paste shortcut through instead of forwarding it', () => {
    expect(html).toContain("if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'v') {");
    expect(html).toContain('armClipboardFallback();');
  });

  it('sends the clipboard as one insert, not a keystroke replay', () => {
    const start = html.indexOf("canvas.addEventListener('paste'");
    const handler = html.slice(start, html.indexOf('const mobileKeyboard =', start));
    expect(handler).toContain("send({ t: 'insert', text: String(text) })");
    expect(handler).not.toContain("t: 'key'");
  });

  it('falls back to reading the clipboard once when no paste event arrives', () => {
    expect(html).toContain('navigator.clipboard.readText()');
    expect(html).toContain('}, 150);');
    // The armed timer is the flag: a real paste event clears it, so the text
    // can never be inserted twice.
    expect(html).toContain('clearTimeout(clipboardFallback);');
  });
});
