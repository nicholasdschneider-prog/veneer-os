/**
 * Viewer for the CDP desktop: a compact Focus mode header over a canvas that
 * renders `Page.screencastFrame` JPEGs and sends mouse/keyboard back over
 * /ws/desktop. Replaces the noVNC iframe, and with it the
 * `/usr/share/novnc` filesystem dependency.
 *
 * No build step — inline CSS/JS only, matching desktopPage.ts.
 */
export function cdpDesktopPageHtml(options: {
  websocketPath?: string;
  /**
   * The app origin this page is embedded by when it is served from somewhere
   * else (the LAN listener). Host messages are trusted from, and posted to,
   * that origin instead of the page's own.
   */
  appOrigin?: string | null;
  title?: string;
  subtitle?: string;
  reportViewerHints?: boolean;
} = {}): string {
  const websocketPath = JSON.stringify(options.websocketPath ?? '/ws/desktop');
  const appOrigin = JSON.stringify(options.appOrigin ?? null);
  const reportViewerHints = options.reportViewerHints === true;
  const title = options.title ?? 'Agent Browser';
  const subtitle = options.subtitle ?? 'Shared desktop';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
<title>${title} — Veneer Pro</title>
<script>
// Runs before the stylesheet so the viewer never flashes the wrong theme. The
// app owns these keys and this page is a same-origin iframe of it, so a storage
// event is enough to follow a theme change made in the surrounding app.
(function () {
  var root = document.documentElement;
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function prefersDark() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }
  function isDark() {
    if (read('vp-theme') === 'terminal') return true;
    var mode = read('vp-color-mode');
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return prefersDark();
  }
  function apply() {
    if (isDark()) root.classList.add('dark');
    else root.classList.remove('dark');
  }
  apply();
  try {
    window.addEventListener('storage', apply);
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    if (query.addEventListener) query.addEventListener('change', apply);
    else if (query.addListener) query.addListener(apply);
  } catch (e) {}
})();
</script>
<style>
  :root {
    color-scheme: light;
    --bg: #fcfbf9; --sidebar: #f5f3f0; --fg: #292826; --muted: #e8e5e0; --muted-fg: #6b6863;
    --border: rgba(41,40,38,0.12); --brand: #7b7062; --ring: #7b7062; --ok: #2f9e5b; --live: #d64545;
  }
  html.dark {
    color-scheme: dark;
    --bg: #191c21; --sidebar: #20242a; --fg: #f2f4f6; --muted: #30353d; --muted-fg: #b3b8c0;
    --border: rgba(255,255,255,0.10); --brand: #aeb8c7; --ring: #aeb8c7; --ok: #5fcf8a; --live: #ff6b6b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: var(--viewer-height, 100dvh); background: var(--bg); color: var(--fg);
    font-family: 'InterVariable', Inter, system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 8px; padding: 7px 14px;
    background: var(--sidebar); color: var(--fg); border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  .brand { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  h1 { color: var(--fg); font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0.1px; white-space: nowrap; }
  .subtitle { color: var(--muted-fg); font-size: 11px; white-space: nowrap; }
  button { font: inherit; cursor: pointer; border: 0; background: transparent; color: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  /* ── Address row ───────────────────────────────────────────────────────── */
  #nav { display: flex; align-items: center; height: 44px; gap: 2px; padding: 0 6px 0 4px; flex: 0 0 auto;
    background: var(--bg); border-bottom: 1px solid var(--border); }
  #nav button { flex: 0 0 auto; width: 32px; height: 32px; padding: 0; display: grid; place-items: center;
    border-radius: 8px; background: transparent; color: var(--muted-fg); }
  #nav button:hover { background: var(--muted); color: var(--fg); }
  #nav button svg { display: block; width: 16px; height: 16px; }
  #url-shell { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; height: 32px; gap: 8px;
    margin: 0 4px; padding: 0 10px 0 10px; border-radius: 999px; background: var(--muted); }
  #url-shell:focus-within { outline: 2px solid var(--ring); outline-offset: -1px; }
  .url-lock { flex: 0 0 14px; display: block; width: 14px; height: 14px; color: var(--muted-fg); }
  .url-field { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; height: 100%; }
  #url { width: 100%; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent;
    color: transparent; caret-color: var(--fg); font: inherit; font-size: 13px; }
  #url::placeholder { color: var(--muted-fg); }
  #url:focus { outline: none; color: var(--fg); }
  /* The input keeps the caret and the selection; the overlay draws the host in
     ink and the rest of the address in grey. Only one of them is ever visible. */
  #url.plain, #url-shell.editing #url { color: var(--fg); }
  #url-display { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis; pointer-events: none;
    font-size: 13px; line-height: 1.3; color: var(--muted-fg); }
  #url-display b { font-weight: 500; color: var(--fg); }
  #url-display .path { color: var(--muted-fg); }
  .url-field:focus-within #url-display, #url-shell.editing #url-display { display: none; }
  #agent-summary { flex: 0 0 auto; display: flex; align-items: center; gap: 5px;
    color: var(--muted-fg); font-size: 12px; font-weight: 500; white-space: nowrap; }
  .agent-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 999px; background: var(--ok); }
  .agent-summary-label { display: none; }
  /* Advanced capture reads the page's network traffic, so the dot goes live. */
  body.capture .agent-dot { background: var(--live); box-shadow: 0 0 0 3px color-mix(in oklab, var(--live) 25%, transparent); }
  #nav #keyboard-toggle { display: none; }
  #nav #keyboard-toggle svg { width: 18px; height: 18px; }
  #mobile-keyboard { display: none; gap: 7px; align-items: center;
    padding: 7px max(10px, env(safe-area-inset-right)) 7px max(10px, env(safe-area-inset-left));
    background: var(--sidebar); border-bottom: 1px solid var(--border); flex: 0 0 auto; }
  #mobile-keyboard.open { display: flex; }
  #mobile-keyboard-input { flex: 1 1 auto; min-width: 90px; height: 42px; resize: none;
    border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px;
    background: var(--bg); color: var(--fg); font: inherit; font-size: 16px; line-height: 22px; }
  #mobile-keyboard-input:focus { outline: 2px solid var(--ring); outline-offset: -1px; }
  #mobile-keyboard-keys { display: flex; gap: 5px; overflow-x: auto; overscroll-behavior-x: contain; }
  #mobile-keyboard-keys button { min-width: 42px; min-height: 42px; padding: 5px 8px; border-radius: 8px;
    background: transparent; color: var(--fg); font-size: 13px; }
  #mobile-keyboard-keys button:hover { background: var(--muted); }
  #keyboard-close { flex: 0 0 48px; width: 48px; height: 48px; padding: 0; border-radius: 999px;
    background: var(--muted); color: var(--fg); font-size: 24px; line-height: 1; }
  /* Touch controls stay visually compact. Their pseudo-elements keep a full
     target without making the browser chrome taller. */
  @media (pointer: coarse), (max-width: 767px) {
    #nav { gap: 2px; padding: 2px max(6px, env(safe-area-inset-right)) 2px max(6px, env(safe-area-inset-left)); }
    #nav button { position: relative; width: 40px; height: 40px; min-width: 40px; min-height: 40px; padding: 0; }
    #nav button::after { content: ''; position: absolute; top: 50%; left: 50%; width: 48px; height: 48px;
      transform: translate(-50%, -50%); }
    #url-shell { height: 40px; }
    /* iOS checks the 16px computed size before the visual scale, so the text
       looks compact without the browser zooming the whole viewer on focus. */
    #url { width: 123.077%; font-size: 16px; transform: scale(0.8125); transform-origin: left center; }
  }
  /* Only a real touch device needs the on-screen keyboard and loses Forward.
     The in-app panel is narrower than 768px on a desktop too, and there the
     hardware keyboard already types into the canvas. Back always stays: the
     panel hides the tab strip that would otherwise carry it. */
  @media (pointer: coarse) {
    #nav #forward { display: none; }
    #nav #keyboard-toggle { display: grid; }
  }
  /* ── Panel host layouts ──────────────────────────────────────────────────
     The chat panel draws its own controls on top of this address row, so the
     viewer reserves the space they land in. These numbers are a contract with
     the React side. The rules sit after the touch media block, and outrank its
     padding shorthand on specificity, so the reservation survives on a phone. */
  body.host-desktop #nav { padding-right: 48px; }
  /* Nothing may draw along the top edge: the panel's active tab sits directly
     above and has to merge into this row. */
  body.host-desktop #nav { border-top: 0; box-shadow: none; }
  body.host-mobile #nav { padding-left: 50px; padding-right: 92px; }
  /* The panel's overlays leave no room for Reload; re-navigating reloads. */
  body.host-mobile #nav #reload { display: none; }
  /* On a phone the omnibox reads as a page title: title over host, both inside
     the 40px pill (14px + 12px), centred by the overlay's own translate. */
  body.host-mobile #url-display.two-line { line-height: 1; text-overflow: clip; }
  body.host-mobile #url-display .omni-title { display: block; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; color: var(--fg); font-size: 13px; font-weight: 500; line-height: 14px; }
  body.host-mobile #url-display .omni-host { display: block; overflow: hidden; white-space: nowrap;
    text-overflow: ellipsis; color: var(--muted-fg); font-size: 11px; line-height: 12px; }
  /* The in-app overlay has its own title bar. */
  body.embedded header { display: none; }
  /* The app's own tab bar is drawing the tabs; the viewer only feeds it. */
  body.hosttabs #tab-strip { display: none; }
  /* The thumbnail is 180x120 of pure picture: no chrome, no input. */
  body.viewonly header, body.viewonly #nav, body.viewonly #tab-strip, body.viewonly #mobile-keyboard { display: none; }
  body.viewonly canvas { cursor: default; pointer-events: none; }
  /* ── Tab strip ─────────────────────────────────────────────────────────── */
  #tab-strip { display: flex; flex: 0 0 auto; min-width: 0; align-items: center; height: 44px; overflow: hidden;
    padding: 0 6px 0 8px; background: var(--sidebar); }
  #tab-back, #tab-forward { display: none; }
  /* Grow is off so the "+" hugs the last tab instead of drifting to the far
     right of the strip; the tabs still scroll once they run out of room. */
  #tabs { display: flex; flex: 0 1 auto; min-width: 0; align-items: center; gap: 2px;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
  #tabs::-webkit-scrollbar { display: none; }
  #tabs:empty { display: none; }
  #tab-new { flex: 0 0 32px; width: 32px; height: 32px; margin: 0; padding: 0; display: grid; place-items: center;
    border-radius: 8px; background: transparent; color: var(--muted-fg); }
  #tab-new:hover { background: var(--muted); color: var(--fg); }
  #tab-new:focus-visible { outline-offset: -2px; }
  #tab-new svg, #tab-back svg, #tab-forward svg { display: block; width: 16px; height: 16px; }
  /* No tabs yet, no lone "+": the strip stays invisible until the list lands. */
  #tabs:empty + #tab-new { display: none; }
  .tab { display: flex; flex: 0 1 150px; align-items: center; min-width: 96px; max-width: 150px; height: 32px;
    position: relative; padding: 0 6px 0 10px; border-radius: 8px;
    background: transparent; color: var(--muted-fg); }
  .tab:hover { background: var(--muted); }
  .tab.active { background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
  .tab-fav { flex: 0 0 14px; width: 14px; height: 14px; border-radius: 4px; background: var(--muted-fg); opacity: 0.35; }
  .tab-select { display: flex; align-items: center; gap: 7px; flex: 1 1 auto; min-width: 0; height: 100%;
    padding: 0; background: transparent; color: inherit; font-size: 13px; font-weight: 500; text-align: left; }
  .tab-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Only the active tab can be closed, so an inactive tab is one target: select. */
  .tab-close { display: none; flex: 0 0 20px; width: 20px; height: 20px; padding: 0;
    border-radius: 6px; background: transparent; color: inherit; }
  .tab-close svg { display: block; width: 14px; height: 14px; }
  .tab.active .tab-close { display: grid; place-items: center; }
  .tab-close:hover { background: var(--muted); }
  .tab-select:focus-visible, .tab-close:focus-visible { outline-offset: -3px; }
  @media (pointer: coarse), (max-width: 767px) {
    #tab-strip { padding-left: max(4px, env(safe-area-inset-left)); padding-right: max(4px, env(safe-area-inset-right)); }
    #tab-back, #tab-forward { position: relative; display: grid; flex: 0 0 38px; width: 38px; height: 38px;
      place-items: center; padding: 0; background: transparent; color: var(--muted-fg); }
    #tab-back::after, #tab-forward::after { content: ''; position: absolute; top: 50%; left: 50%; width: 48px; height: 48px;
      transform: translate(-50%, -50%); }
    #tab-new { position: relative; }
    #tab-new::after { content: ''; position: absolute; top: 50%; left: 50%; width: 48px; height: 48px;
      transform: translate(-50%, -50%); }
    .tab { flex-basis: 150px; min-width: 112px; }
    .tab-select { gap: 8px; font-size: 13px; }
    .tab-close { position: relative; }
    .tab-close::after { content: ''; position: absolute; top: 50%; left: 50%; width: 48px; height: 48px;
      transform: translate(-50%, -50%); }
  }
  /* ── Viewport ──────────────────────────────────────────────────────────── */
  main { flex: 1 1 auto; position: relative; background: #111317; overflow: hidden; }
  canvas { position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%;
    outline: none; cursor: default; }
  #agent-cursor { position: absolute; top: 0; left: 0; z-index: 2; width: 18px; height: 24px;
    pointer-events: none; opacity: 0; transform: translate(-100px, -100px); transition: opacity 180ms ease; }
  #agent-cursor.visible { opacity: 1; }
  .agent-cursor-pointer { position: absolute; inset: 0; background: #7c5ce0;
    clip-path: polygon(0 0, 0 82%, 5px 65%, 9px 77%, 13px 75%, 9px 62%, 18px 62%);
    filter: drop-shadow(0 1px 0 rgba(255,255,255,0.85)) drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
  .agent-cursor-click { position: absolute; top: -8px; left: -8px; width: 18px; height: 18px;
    border: 2px solid #9f8aef; border-radius: 999px; opacity: 0; }
  #agent-cursor.clicking .agent-cursor-click { animation: agent-cursor-click 420ms ease-out; }
  @keyframes agent-cursor-click {
    0% { opacity: 0.95; transform: scale(0.35); }
    100% { opacity: 0; transform: scale(1.8); }
  }
  @media (pointer: coarse), (max-width: 767px) { canvas { touch-action: none; } }
  #status { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--muted-fg); font-size: 14px; text-align: center; padding: 24px; }
  #status.show { display: flex; }
  #picker { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(17,19,23,0.82); }
  #picker.show { display: flex; }
  #picker .card { background: var(--bg); color: var(--fg); border-radius: 12px; padding: 20px 22px;
    max-width: 380px; text-align: center; box-shadow: 0 0 0 1px var(--border); }
  html.dark #picker .card { box-shadow: none; }
  #picker h2 { font-size: 15px; margin: 0 0 6px; }
  #picker p { font-size: 13px; color: var(--muted-fg); margin: 0 0 14px; }
  #picker .row { display: flex; gap: 8px; justify-content: center; align-items: center; }
  #picker .row button { padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 500;
    background: var(--fg); color: var(--bg); }
  #picker .row button.off { background: transparent; color: var(--fg); border: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>${title}</h1>
    <span class="subtitle">${subtitle}</span>
  </div>
</header>
<div id="tab-strip">
  <button id="tab-back" type="button" title="Back" aria-label="Back"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg></button>
  <button id="tab-forward" type="button" title="Forward" aria-label="Forward"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg></button>
  <div id="tabs" role="tablist" aria-label="Open browser tabs"></div>
  <button id="tab-new" type="button" title="New tab" aria-label="New tab"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg></button>
</div>
<div id="nav">
  <button id="back" type="button" title="Back" aria-label="Back"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="m15 18-6-6 6-6"></path></svg></button>
  <button id="forward" type="button" title="Forward" aria-label="Forward"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg></button>
  <button id="reload" type="button" title="Reload" aria-label="Reload"><svg aria-hidden="true" width="16" height="16"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
    <path d="M21 3v5h-5"></path></svg></button>
  <div id="url-shell">
    <svg class="url-lock" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
    <span class="url-field">
      <input id="url" name="url" type="text" spellcheck="false" autocapitalize="off" autocomplete="off"
        autocorrect="off" enterkeyhint="go" placeholder="Search or enter address" aria-label="Browser address" />
      <span id="url-display" aria-hidden="true"></span>
    </span>
    <span id="agent-summary" aria-label="Agents have browser access." title="Agents have browser access.">
      <span class="agent-dot" aria-hidden="true"></span>
      <span class="agent-summary-label">Agents</span>
    </span>
  </div>
  <button id="keyboard-toggle" type="button" title="Open keyboard" aria-label="Open keyboard"
    aria-controls="mobile-keyboard" aria-expanded="false"><svg class="lucide lucide-keyboard" aria-hidden="true"
      width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 8h.01"></path><path d="M12 12h.01"></path><path d="M14 8h.01"></path>
      <path d="M16 12h.01"></path><path d="M18 8h.01"></path><path d="M6 8h.01"></path>
      <path d="M7 16h10"></path><path d="M8 12h.01"></path><rect width="20" height="16" x="2" y="4" rx="2"></rect>
    </svg></button>
</div>
<div id="mobile-keyboard" aria-label="Remote keyboard controls">
  <textarea id="mobile-keyboard-input" name="mobile-keyboard" rows="1" inputmode="text" enterkeyhint="enter"
    autocapitalize="sentences" autocomplete="off" autocorrect="on" spellcheck="true"
    aria-label="Type in the remote browser" placeholder="Type here"></textarea>
  <div id="mobile-keyboard-keys" aria-label="Common keys">
    <button type="button" data-key="Backspace" aria-label="Backspace">&#9003;</button>
    <button type="button" data-key="Tab">Tab</button>
    <button type="button" data-key="Escape">Esc</button>
    <button type="button" data-key="ArrowLeft" aria-label="Left arrow">&larr;</button>
    <button type="button" data-key="ArrowUp" aria-label="Up arrow">&uarr;</button>
    <button type="button" data-key="ArrowDown" aria-label="Down arrow">&darr;</button>
    <button type="button" data-key="ArrowRight" aria-label="Right arrow">&rarr;</button>
    <button type="button" data-key="Enter">Enter</button>
  </div>
  <button id="keyboard-close" type="button" aria-label="Close keyboard">&times;</button>
</div>
<main>
  <canvas id="screen" tabindex="0"></canvas>
  <div id="agent-cursor" aria-hidden="true">
    <span class="agent-cursor-pointer"></span>
    <span class="agent-cursor-click"></span>
  </div>
  <div id="status" class="show">Connecting to the shared browser…</div>
  <div id="picker">
    <div class="card">
      <h2>The page is asking for a file</h2>
      <p>Chrome runs headless here, so choose the file on this device and it will be handed to the page.</p>
      <div class="row">
        <input id="file" name="file" type="file" aria-label="Choose a file to upload" />
        <button id="file-cancel" type="button" class="off">Cancel</button>
      </div>
    </div>
  </div>
</main>
<script>
(function () {
  const canvas = document.getElementById('screen');
  const statusEl = document.getElementById('status');
  const tabsEl = document.getElementById('tabs');
  const agentCursorEl = document.getElementById('agent-cursor');
  const ctx = canvas.getContext('2d', { alpha: false });
  // Three embedded modes, all used by the in-app browser surfaces:
  //   view=only  → the 180x120 thumbnail. Frames only: no chrome, no input.
  //   chrome=off → the fullscreen overlay, which draws its own title bar.
  //   tabs=off   → the chat panel, which draws its own tab bar and talks to
  //                this frame over postMessage.
  //   host=…     → which of the panel's two layouts is around us (always with
  //                tabs=off). The panel overlays controls on the address row,
  //                so the row reserves their space and the phone layout reads
  //                the omnibox as a page title.
  const params = new URLSearchParams(location.search);
  const viewOnly = params.get('view') === 'only';
  const hostTabs = params.get('tabs') === 'off';
  const hostLayout = params.get('host');
  const hostMobile = hostLayout === 'mobile';
  const reportViewerHints = ${JSON.stringify(reportViewerHints)};
  if (viewOnly) document.body.classList.add('viewonly');
  if (viewOnly || params.get('chrome') === 'off') document.body.classList.add('embedded');
  if (hostTabs) document.body.classList.add('hosttabs');
  if (hostLayout === 'desktop') document.body.classList.add('host-desktop');
  else if (hostMobile) document.body.classList.add('host-mobile');
  let ws = null;
  let backoff = 500;
  let viewportSize = { w: 1280, h: 800 };
  let activeId = null;
  let activeTitle = '';
  let mobileKeyboardInputFocused = false;
  let agentCursor = null;
  let agentCursorHideTimer = null;
  let agentCursorClickTimer = null;

  // ── Host bridge ──────────────────────────────────────────────────────────
  // Only the chat panel embed: it hides the strip, so it needs the tab list and
  // has to be able to drive activate/close/newtab from its own chrome.
  const hostBridge = !viewOnly && hostTabs && window.parent !== window;
  // Served from the LAN listener, this page belongs to another origin than the
  // app around it; the app that minted the ticket is the only trusted host.
  const hostOrigin = ${appOrigin} || window.location.origin;
  function postToHost(msg) {
    if (!hostBridge) return;
    try { window.parent.postMessage(msg, hostOrigin); } catch {}
  }
  postToHost({ source: 'veneer-browser-viewer', t: 'ready' });

  const agentSummaryEl = document.getElementById('agent-summary');
  const AGENT_ACCESS_TEXT = 'Agents have browser access.';
  const AGENT_CAPTURE_TEXT = "Advanced capture on. The agent can read this browser's network traffic.";
  function setCaptureState(active) {
    document.body.classList.toggle('capture', !!active);
    if (!agentSummaryEl) return;
    const text = active ? AGENT_CAPTURE_TEXT : AGENT_ACCESS_TEXT;
    agentSummaryEl.title = text;
    agentSummaryEl.setAttribute('aria-label', text);
  }

  const ICON_CLOSE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none"' +
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';

  // iOS changes the visual viewport, but not always the CSS layout viewport,
  // when its keyboard opens. Keep the controls and canvas inside the visible
  // part of the screen.
  function syncViewerHeight() {
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--viewer-height', Math.round(height) + 'px');
  }
  syncViewerHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewerHeight);
    window.visualViewport.addEventListener('scroll', syncViewerHeight);
  }

  function setStatus(text) {
    if (text) { statusEl.textContent = text; statusEl.classList.add('show'); }
    else statusEl.classList.remove('show');
  }

  // ── Frame rendering ──────────────────────────────────────────────────────
  // Ack only after the frame is on screen: that ack is what asks Chrome for the
  // next one, so a slow client throttles the stream instead of queueing it.
  // The host drops its start-up screen the moment a real frame arrives. Signal
  // on the raw bytes, not after decode, so a slow or failed createImageBitmap
  // can never hold the loading screen over a browser that is already streaming.
  let announcedFrame = false;
  function announceFirstFrame() {
    if (announcedFrame) return;
    announcedFrame = true;
    postToHost({ source: 'veneer-browser-viewer', t: 'frame' });
  }
  function drawFrame(blob) {
    createImageBitmap(blob).then((bitmap) => {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      positionAgentCursor();
      setStatus('');
      // Announce only once a real picture is on the canvas, so the host's orb
      // never clears to a blank/"waiting" frame on a decode that failed.
      announceFirstFrame();
      send({ t: 'ack' });
    }).catch(() => send({ t: 'ack' }));
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // Agent coordinates arrive in remote CSS pixels. Draw the pointer over the
  // letterboxed canvas only; it never enters the page DOM or captured frames.
  function positionAgentCursor() {
    if (!agentCursor) return;
    if (
      agentCursor.x < 0 || agentCursor.y < 0 ||
      agentCursor.x > viewportSize.w || agentCursor.y > viewportSize.h
    ) {
      agentCursorEl.classList.remove('visible');
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const mainRect = canvas.parentElement.getBoundingClientRect();
    const x = canvasRect.left - mainRect.left + (agentCursor.x / viewportSize.w) * canvasRect.width;
    const y = canvasRect.top - mainRect.top + (agentCursor.y / viewportSize.h) * canvasRect.height;
    agentCursorEl.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
  }

  function showAgentCursor(message) {
    agentCursor = { x: Number(message.x), y: Number(message.y) };
    if (!Number.isFinite(agentCursor.x) || !Number.isFinite(agentCursor.y)) return;
    positionAgentCursor();
    agentCursorEl.classList.add('visible');
    clearTimeout(agentCursorHideTimer);
    agentCursorHideTimer = setTimeout(() => agentCursorEl.classList.remove('visible'), 1600);
    if (message.type !== 'mousePressed') return;
    agentCursorEl.classList.remove('clicking');
    void agentCursorEl.offsetWidth;
    agentCursorEl.classList.add('clicking');
    clearTimeout(agentCursorClickTimer);
    agentCursorClickTimer = setTimeout(() => agentCursorEl.classList.remove('clicking'), 450);
  }

  function renderTabs(list) {
    // The omnibox borrows the active tab's title in the panel's phone layout,
    // so every tab list refreshes it — including an empty one.
    setActiveTitle(list);
    refreshUrlDisplay();
    tabsEl.innerHTML = '';
    if (!list || !list.length) return;
    for (const target of list) {
      const label = target.title || target.url || 'Untitled';
      const isActive = target.targetId === activeId;
      const tab = document.createElement('div');
      tab.className = 'tab' + (isActive ? ' active' : '');

      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'tab-select';
      selectButton.setAttribute('role', 'tab');
      selectButton.setAttribute('aria-selected', String(isActive));
      selectButton.title = target.url || label;
      // There is no favicon on this wire, so the slot stays a neutral chip
      // rather than pretending to be a site mark.
      const favEl = document.createElement('span');
      favEl.className = 'tab-fav';
      favEl.setAttribute('aria-hidden', 'true');
      selectButton.appendChild(favEl);
      const labelEl = document.createElement('span');
      labelEl.className = 'tab-label';
      labelEl.textContent = label;
      selectButton.appendChild(labelEl);
      selectButton.addEventListener('click', () => send({ t: 'activate', targetId: target.targetId }));

      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'tab-close';
      closeButton.innerHTML = ICON_CLOSE;
      closeButton.title = 'Close tab';
      closeButton.setAttribute('aria-label', 'Close ' + label);
      closeButton.addEventListener('click', () => {
        send({ t: 'close', targetId: target.targetId });
        canvas.focus();
      });

      tab.append(selectButton, closeButton);
      tabsEl.appendChild(tab);
    }
  }

  // ── Address bar ──────────────────────────────────────────────────────────
  // The field mirrors whatever the page navigates to, but never while you are
  // typing in it — losing a half-typed address to a background navigation is
  // the one thing an address bar must not do.
  const urlInput = document.getElementById('url');
  const urlShell = document.getElementById('url-shell');
  const urlDisplay = document.getElementById('url-display');
  let editing = false;
  let lastUrl = '';

  // The active tab's title, tracked off the targets message. about:blank and a
  // placeholder are not titles, and neither is the address echoed back.
  function setActiveTitle(list) {
    const active = (list || []).find((target) => target.targetId === activeId);
    activeTitle = active && active.title ? String(active.title) : '';
  }
  function pageTitle() {
    const title = activeTitle.trim();
    if (!title || title === 'about:blank' || title === 'Untitled') return '';
    if (title === lastUrl) return '';
    return title;
  }
  function refreshUrlDisplay() { renderUrlDisplay(lastUrl); }

  // The overlay is what the reader sees: host in ink, the rest in grey. Keep it
  // defensive — an unparseable address is still an address worth showing.
  function renderUrlDisplay(url) {
    if (!urlDisplay) return;
    const text = String(url || '');
    lastUrl = text;
    urlDisplay.textContent = '';
    urlDisplay.classList.remove('two-line');
    if (!text) { urlInput.classList.add('plain'); return; }
    urlInput.classList.remove('plain');
    let host = '';
    let rest = text;
    try {
      const parsed = new URL(text);
      host = parsed.host || '';
      if (host) rest = text.slice(text.indexOf(host) + host.length);
    } catch { host = ''; rest = text; }
    // The panel's phone layout reads this row as a page title: the tab's title
    // over its host. Untitled pages keep today's host-bold single line.
    const title = hostMobile && host ? pageTitle() : '';
    if (title) {
      urlDisplay.classList.add('two-line');
      const titleEl = document.createElement('span');
      titleEl.className = 'omni-title';
      titleEl.textContent = title;
      const hostLine = document.createElement('span');
      hostLine.className = 'omni-host';
      hostLine.textContent = host;
      urlDisplay.append(titleEl, hostLine);
      return;
    }
    if (host) {
      const hostEl = document.createElement('b');
      hostEl.textContent = host;
      urlDisplay.appendChild(hostEl);
    }
    const pathEl = document.createElement('span');
    pathEl.className = 'path';
    pathEl.textContent = rest;
    urlDisplay.appendChild(pathEl);
  }
  renderUrlDisplay('');

  function showUrl(url) {
    if (editing || !url) return;
    urlInput.value = url;
    renderUrlDisplay(url);
  }

  // Host-shaped text gets https://; anything else is a search, the same bargain
  // Chrome's own omnibox makes.
  function toUrl(text) {
    const value = text.trim();
    if (!value) return '';
    if (value.indexOf('://') > 0 || value === 'about:blank') return value;
    const bare = value.indexOf(' ') === -1;
    if (bare && (value.indexOf('.') > 0 || value.indexOf('localhost') === 0)) return 'https://' + value;
    return 'https://www.google.com/search?q=' + encodeURIComponent(value);
  }

  // Hand the keyboard back to the page after every control: the canvas is where
  // keystrokes have to land for the browser to feel like a browser.
  function returnFocus() {
    editing = false;
    if (urlShell) urlShell.classList.remove('editing');
    urlInput.blur();
    canvas.focus();
  }

  // A new tab opens on about:blank, so the address bar — not the blank page —
  // is where the next keystroke belongs.
  function newTab() {
    send({ t: 'newtab' });
    urlInput.value = '';
    activeTitle = '';
    renderUrlDisplay('');
    urlInput.focus();
    urlInput.select();
  }

  if (!viewOnly) {
  urlInput.addEventListener('focus', () => {
    editing = true;
    if (urlShell) urlShell.classList.add('editing');
    urlInput.select();
  });
  urlInput.addEventListener('blur', () => {
    editing = false;
    if (urlShell) urlShell.classList.remove('editing');
  });
  urlInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { returnFocus(); return; }
    if (e.key !== 'Enter') return;
    const url = toUrl(urlInput.value);
    if (!url) return;
    urlInput.value = url;
    renderUrlDisplay(url);
    send({ t: 'navigate', url });
    returnFocus();
  });

  document.getElementById('tab-new').addEventListener('click', newTab);

  function navControl(id, msg) {
    document.getElementById(id).addEventListener('click', () => {
      send(msg);
      canvas.focus();
    });
  }
  navControl('back', { t: 'history', delta: -1 });
  navControl('tab-back', { t: 'history', delta: -1 });
  navControl('forward', { t: 'history', delta: 1 });
  navControl('tab-forward', { t: 'history', delta: 1 });
  navControl('reload', { t: 'reload' });

  // The panel around this frame owns the tab chrome, so it drives the same
  // three actions the strip would. Same-origin parent only.
  if (hostBridge) {
    window.addEventListener('message', (event) => {
      const trusted = event.origin === hostOrigin && event.source === window.parent &&
        event.data && event.data.source === 'veneer-browser-host';
      if (!trusted) return;
      const data = event.data;
      if (data.t === 'activate' && data.targetId) send({ t: 'activate', targetId: data.targetId });
      else if (data.t === 'close' && data.targetId) send({ t: 'close', targetId: data.targetId });
      else if (data.t === 'newtab') newTab();
      else if (data.t === 'capture') setCaptureState(!!data.active);
    });
  }
  }

  // ── Coordinate mapping ───────────────────────────────────────────────────
  // The canvas is letterboxed inside <main>, so map client pixels back to page
  // pixels through the displayed rect.
  function pagePoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? viewportSize.w / rect.width : 1;
    const scaleY = rect.height ? viewportSize.h / rect.height : 1;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  }

  function modifiersOf(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }

  const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];

  function pressedButton(buttons) {
    if (buttons & 1) return 'left';
    if (buttons & 4) return 'middle';
    if (buttons & 2) return 'right';
    if (buttons & 8) return 'back';
    if (buttons & 16) return 'forward';
    return 'none';
  }

  function mouse(type, event) {
    const point = pagePoint(event);
    send({
      t: 'mouse', type, x: point.x, y: point.y,
      button: type === 'mouseMoved' ? pressedButton(event.buttons) : (BUTTONS[event.button] || 'left'),
      buttons: event.buttons || 0,
      clickCount: type === 'mouseMoved' ? 0 : (event.detail || 1),
      modifiers: modifiersOf(event),
    });
  }

  // Every listener below drives the user's real browser, so a view-only frame
  // registers none of them.
  if (!viewOnly) {
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') mouse('mouseMoved', e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    e.preventDefault();
    canvas.focus();
    mouse('mousePressed', e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse('mouseReleased', e);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse('mouseReleased', e);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const point = pagePoint(e);
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width ? viewportSize.w / rect.width : 1;
    const scaleY = rect.height ? viewportSize.h / rect.height : 1;
    // Browser wheel events use pixels, lines or pages. CDP always expects CSS
    // pixels in the remote viewport. Keep the browser's sign: positive Y is
    // downward scrolling in both APIs.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
    send({
      t: 'mouse', type: 'mouseWheel', x: point.x, y: point.y,
      deltaX: e.deltaX * unit * scaleX, deltaY: e.deltaY * unit * scaleY,
      button: 'none', buttons: e.buttons || 0, clickCount: 0, modifiers: modifiersOf(e),
    });
  }, { passive: false });

  // A remote canvas has no native mobile scrolling. Convert one-finger drags
  // into wheel input at the touched page point. A short touch remains a click.
  let touchGesture = null;
  function touchMouse(type, touch, buttons) {
    const point = pagePoint(touch);
    send({
      t: 'mouse', type, x: point.x, y: point.y,
      button: 'left', buttons, clickCount: 1, modifiers: 0,
    });
  }
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { touchGesture = null; return; }
    e.preventDefault();
    const touch = e.touches[0];
    touchGesture = {
      startX: touch.clientX, startY: touch.clientY,
      lastX: touch.clientX, lastY: touch.clientY, moved: false,
    };
    canvas.focus({ preventScroll: true });
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (!touchGesture || e.touches.length !== 1) return;
    e.preventDefault();
    const touch = e.touches[0];
    if (!touchGesture.moved && Math.hypot(touch.clientX - touchGesture.startX, touch.clientY - touchGesture.startY) >= 6) {
      touchGesture.moved = true;
    }
    if (touchGesture.moved) {
      const point = pagePoint(touch);
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width ? viewportSize.w / rect.width : 1;
      const scaleY = rect.height ? viewportSize.h / rect.height : 1;
      send({
        t: 'mouse', type: 'mouseWheel', x: point.x, y: point.y,
        deltaX: (touchGesture.lastX - touch.clientX) * scaleX,
        deltaY: (touchGesture.lastY - touch.clientY) * scaleY,
        button: 'none', buttons: 0, clickCount: 0, modifiers: 0, source: 'touch',
      });
    }
    touchGesture.lastX = touch.clientX;
    touchGesture.lastY = touch.clientY;
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    if (!touchGesture) return;
    e.preventDefault();
    const touch = e.changedTouches[0];
    if (!touchGesture.moved && touch) {
      touchMouse('mousePressed', touch, 1);
      touchMouse('mouseReleased', touch, 0);
    }
    touchGesture = null;
  }, { passive: false });
  canvas.addEventListener('touchcancel', () => { touchGesture = null; });

  // ── Keyboard ─────────────────────────────────────────────────────────────
  // Printable keys carry \`text\`, which is what actually types the character;
  // everything else is a bare keyDown/keyUp so shortcuts and navigation work.
  function keyPayload(type, event) {
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    return {
      t: 'key', type,
      key: event.key, code: event.code, keyCode: event.keyCode,
      modifiers: modifiersOf(event),
      text: type === 'keyDown' && printable ? event.key : undefined,
    };
  }

  // Safari does not reliably deliver a paste event to a focused canvas. Arm a
  // short fallback on the shortcut itself and read the clipboard directly if no
  // paste arrives; the timer is the flag, so text is never inserted twice.
  let clipboardFallback = null;
  function armClipboardFallback() {
    if (clipboardFallback) clearTimeout(clipboardFallback);
    clipboardFallback = setTimeout(() => {
      clipboardFallback = null;
      if (!navigator.clipboard || !navigator.clipboard.readText) return;
      navigator.clipboard.readText().then((text) => {
        if (text) send({ t: 'insert', text: text });
      }).catch(() => {});
    }, 150);
  }

  canvas.addEventListener('keydown', (e) => {
    // Cmd/Ctrl-V is the browser's, not the remote page's: preventDefault here
    // would suppress the local paste event (leaving us with no clipboard text),
    // and forwarding the shortcut pastes the VM's own empty clipboard.
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'v') {
      armClipboardFallback();
      return;
    }
    // Leave the browser's own reload/devtools shortcuts alone.
    if (e.key !== 'F5' && e.key !== 'F12') e.preventDefault();
    send(keyPayload('keyDown', e));
  });
  canvas.addEventListener('keyup', (e) => {
    e.preventDefault();
    send(keyPayload('keyUp', e));
  });
  // Clipboard paste: one insert for the whole string. Replaying it character by
  // character loses text in fields that handle input atomically. Copy in the
  // other direction works through the page's own Ctrl/Cmd-C.
  canvas.addEventListener('paste', (e) => {
    e.preventDefault();
    if (clipboardFallback) {
      clearTimeout(clipboardFallback);
      clipboardFallback = null;
    }
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) send({ t: 'insert', text: String(text) });
  });

  // A canvas accepts a hardware keyboard, but iOS does not show its software
  // keyboard for a canvas. This real text field opens the keyboard. Its input
  // is replayed into the remote page, which keeps the focus from the last tap.
  const mobileKeyboard = document.getElementById('mobile-keyboard');
  const mobileKeyboardInput = document.getElementById('mobile-keyboard-input');
  const mobileKeyboardToggle = document.getElementById('keyboard-toggle');
  const mobileKeyboardClose = document.getElementById('keyboard-close');
  const INPUT_SENTINEL = '\\u200b';
  let composing = false;

  const NAMED_KEYS = {
    Backspace: { code: 'Backspace', keyCode: 8 },
    Tab: { code: 'Tab', keyCode: 9 },
    Enter: { code: 'Enter', keyCode: 13 },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    Delete: { code: 'Delete', keyCode: 46 },
  };

  function primeMobileInput() {
    mobileKeyboardInput.value = INPUT_SENTINEL;
    mobileKeyboardInput.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  }

  function sendNamedKey(key) {
    const detail = NAMED_KEYS[key];
    if (!detail) return;
    send({ t: 'key', type: 'keyDown', key, code: detail.code, keyCode: detail.keyCode, modifiers: 0 });
    send({ t: 'key', type: 'keyUp', key, code: detail.code, keyCode: detail.keyCode, modifiers: 0 });
  }

  function sendMobileText(text) {
    for (const ch of String(text)) {
      send({ t: 'key', type: 'keyDown', key: ch, text: ch, modifiers: 0 });
      send({ t: 'key', type: 'keyUp', key: ch, modifiers: 0 });
    }
  }

  function mobileInputText() {
    return mobileKeyboardInput.value.split(INPUT_SENTINEL).join('');
  }

  function openMobileKeyboard() {
    mobileKeyboard.classList.add('open');
    mobileKeyboardToggle.setAttribute('aria-expanded', 'true');
    mobileKeyboardToggle.setAttribute('aria-label', 'Close keyboard');
    primeMobileInput();
    mobileKeyboardInput.focus({ preventScroll: true });
  }

  function closeMobileKeyboard(focusCanvas) {
    if (!mobileKeyboard.classList.contains('open')) return;
    mobileKeyboard.classList.remove('open');
    mobileKeyboardToggle.setAttribute('aria-expanded', 'false');
    mobileKeyboardToggle.setAttribute('aria-label', 'Open keyboard');
    mobileKeyboardInput.blur();
    mobileKeyboardInputFocused = false;
    if (focusCanvas) canvas.focus();
    setTimeout(reportSize, 250);
  }

  mobileKeyboardToggle.addEventListener('click', () => {
    if (mobileKeyboard.classList.contains('open')) closeMobileKeyboard(true);
    else openMobileKeyboard();
  });
  mobileKeyboardClose.addEventListener('pointerdown', (e) => e.preventDefault());
  mobileKeyboardClose.addEventListener('click', () => closeMobileKeyboard(true));
  mobileKeyboardInput.addEventListener('focus', () => { mobileKeyboardInputFocused = true; });
  mobileKeyboardInput.addEventListener('blur', () => {
    mobileKeyboardInputFocused = false;
    // Let key buttons keep the field focused. A real blur, including the iOS
    // Done control or a tap on the remote page, closes the tray.
    setTimeout(() => {
      if (document.activeElement !== mobileKeyboardInput) closeMobileKeyboard(false);
    }, 0);
  });
  mobileKeyboardInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (!NAMED_KEYS[e.key]) return;
    e.preventDefault();
    sendNamedKey(e.key);
    primeMobileInput();
  });
  mobileKeyboardInput.addEventListener('compositionstart', () => { composing = true; });
  mobileKeyboardInput.addEventListener('compositionend', () => {
    composing = false;
    // Some mobile keyboards send the final input after compositionend and
    // some do not. Read after the event queue; a normal input event will have
    // already sent and cleared the value.
    setTimeout(() => {
      const text = mobileInputText();
      if (text) sendMobileText(text);
      primeMobileInput();
    }, 0);
  });
  mobileKeyboardInput.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    const inputType = e.inputType || '';
    const text = mobileInputText();
    if (inputType === 'deleteContentBackward' && !text) sendNamedKey('Backspace');
    else if (inputType === 'deleteContentForward') sendNamedKey('Delete');
    else if (inputType === 'insertLineBreak') sendNamedKey('Enter');
    else if (text) sendMobileText(text);
    primeMobileInput();
  });
  document.querySelectorAll('#mobile-keyboard-keys [data-key]').forEach((button) => {
    // Do not let a key button dismiss the iOS keyboard before its click runs.
    button.addEventListener('pointerdown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      sendNamedKey(button.dataset.key);
      primeMobileInput();
      mobileKeyboardInput.focus({ preventScroll: true });
    });
  });
  }

  // ── File picker ──────────────────────────────────────────────────────────
  // Chrome is headless, so a page asking for a file cannot open a native
  // dialog. The server forwards the request here; we read the file locally and
  // stream it back, and the server points the page's input at it.
  const picker = document.getElementById('picker');
  const fileInput = document.getElementById('file');
  const fileCancel = document.getElementById('file-cancel');
  const CHUNK = 256 * 1024;

  function closePicker() {
    picker.classList.remove('show');
    fileInput.value = '';
    canvas.focus();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    send({ t: 'upload-start', name: file.name, size: file.size });
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const slice = await file.slice(offset, offset + CHUNK).arrayBuffer();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(slice);
    }
    send({ t: 'upload-end' });
    closePicker();
  });

  fileCancel.addEventListener('click', () => {
    send({ t: 'upload-cancel' });
    closePicker();
  });

  // ── Sizing ───────────────────────────────────────────────────────────────
  let resizeTimer = null;
  function reportSize() {
    // The reported size becomes the real browser's viewport, so the 180x120
    // thumbnail must never report: it would squash the page for everyone
    // watching (the server floors it at 320, which is no better).
    if (viewOnly || mobileKeyboardInputFocused) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const main = canvas.parentElement.getBoundingClientRect();
      send({ t: 'resize', w: Math.round(main.width), h: Math.round(main.height) });
    }, 200);
  }
  window.addEventListener('resize', reportSize);
  window.addEventListener('resize', positionAgentCursor);

  // ── Connection ───────────────────────────────────────────────────────────
  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let socketPath = ${websocketPath};
    if (reportViewerHints) {
      const separator = socketPath.indexOf('?') >= 0 ? '&' : '?';
      const dpr = Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1));
      socketPath += separator + 'viewer=' + (viewOnly ? 'thumbnail' : 'full') + '&dpr=' + encodeURIComponent(dpr);
    }
    ws = new WebSocket(scheme + '://' + location.host + socketPath);
    ws.binaryType = 'blob';

    ws.addEventListener('open', () => {
      backoff = 500;
      // Only the very first connection is "waiting for the first frame". A
      // reconnect keeps the last painted frame on the canvas — covering it with
      // that text (over a page that never repaints) is the stuck-status bug.
      if (!announcedFrame) setStatus('Waiting for the first frame…');
      else setStatus('');
      reportSize();
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') { drawFrame(event.data); return; }
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'targets') {
        if (activeId && activeId !== msg.activeId) {
          agentCursor = null;
          agentCursorEl.classList.remove('visible');
        }
        activeId = msg.activeId;
        renderTabs(msg.list);
        const list = msg.list || [];
        postToHost({
          source: 'veneer-browser-viewer', t: 'targets',
          list: list.map((target) => ({
            targetId: target.targetId, title: target.title || '', url: target.url || '',
          })),
          activeId: activeId,
        });
        const active = list.find((target) => target.targetId === activeId);
        showUrl(active && active.url);
      }
      else if (msg.t === 'url') { showUrl(msg.url); }
      else if (msg.t === 'metrics') {
        viewportSize = { w: msg.w, h: msg.h };
        positionAgentCursor();
      }
      else if (msg.t === 'agent-cursor') { showAgentCursor(msg); }
      else if (msg.t === 'filechooser' && !viewOnly) {
        fileInput.multiple = !!msg.multiple;
        picker.classList.add('show');
      }
      else if (msg.t === 'upload-done' && !msg.ok && msg.message) { setStatus(msg.message); setTimeout(() => setStatus(''), 4000); }
      else if (msg.t === 'status' && msg.state !== 'connected') {
        setStatus(msg.message || 'The shared browser is unavailable.');
      }
    });
    ws.addEventListener('close', () => {
      setStatus('Reconnecting…');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }

  connect();
  // Never in an embedded frame: an iframe grabbing focus on load yanks it away
  // from whatever the user was doing in the app around it.
  if (!viewOnly && window.top === window) canvas.focus();
})();
</script>
</body>
</html>`;
}
