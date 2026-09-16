/**
 * Compatibility wrapper for the legacy noVNC desktop. The browser itself keeps
 * its own controls; this page only provides the Focus mode identity bar.
 */
export function desktopWrapperHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Agent Browser — Veneer Pro</title>
<style>
  :root {
    --cream: #faf7f2; --ink: #26221c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--cream); color: var(--ink);
    font-family: Inter, system-ui, -apple-system, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; padding: 7px 14px; flex: 0 0 auto;
    background: var(--ink); border-bottom: 1px solid rgba(255,255,255,0.12); color: var(--cream); }
  .brand { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  h1 { color: var(--cream); font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0.1px; white-space: nowrap; }
  .subtitle { color: rgba(250,247,242,0.62); font-size: 11px; white-space: nowrap; }
  main { flex: 1 1 auto; position: relative; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Agent Browser</h1>
    <span class="subtitle">Shared desktop</span>
  </div>
</header>
<main>
  <iframe src="/desktop/novnc/vnc.html?autoconnect=1&amp;path=ws/desktop&amp;resize=scale&amp;reconnect=true"
    title="Agent Browser" allow="clipboard-read; clipboard-write"></iframe>
</main>
</body>
</html>`;
}
