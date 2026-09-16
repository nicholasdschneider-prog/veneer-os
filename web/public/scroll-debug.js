// Temporary scroll-jank diagnostic (see /scroll-lab.html for the CSS half).
// Loaded as a classic script BEFORE the app bundle so it can install a
// devtools hook shim and count React commits in the production build.
// Enable with ?scrolldebug in the URL (persists), disable with ?scrolldebug=off.
(() => {
  try {
    const q = location.search;
    if (q.includes('scrolldebug=off')) localStorage.removeItem('vpScrollDebug');
    else if (q.includes('scrolldebug')) localStorage.setItem('vpScrollDebug', '1');
    if (localStorage.getItem('vpScrollDebug') !== '1') return;
  } catch {
    return;
  }

  const dbg = { commits: [], scrolls: [], mutations: [], worst: 0 };

  // React calls these through try/catch, so a partial shim is safe in prod.
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      isDisabled: false,
      checkDCE: () => {},
      inject: () => 1,
      onScheduleFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: () => dbg.commits.push(performance.now()),
    };
  }

  window.addEventListener('scroll', () => dbg.scrolls.push(performance.now()), {
    capture: true,
    passive: true,
  });

  addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      const now = performance.now();
      for (let i = 0; i < list.length; i++) dbg.mutations.push(now);
    }).observe(document.body, { subtree: true, childList: true, attributes: true });

    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:calc(env(safe-area-inset-top) + 4px);right:4px;z-index:99999;' +
      'background:rgba(0,0,0,.75);color:#4ec9b0;font:11px/1.5 ui-monospace,monospace;' +
      'padding:4px 7px;border-radius:6px;pointer-events:none;white-space:pre;text-align:right';
    document.body.appendChild(el);

    let last = performance.now();
    const prune = (a, cut) => {
      while (a.length && a[0] < cut) a.shift();
    };
    const tick = (now) => {
      const dt = now - last;
      last = now;
      if (dt > dbg.worst) dbg.worst = dt;
      const cut = now - 5000;
      prune(dbg.commits, cut);
      prune(dbg.scrolls, cut);
      prune(dbg.mutations, cut);
      el.textContent =
        `worst ${dbg.worst.toFixed(0)}ms\n` +
        `commits/5s ${dbg.commits.length}\n` +
        `scrolls/5s ${dbg.scrolls.length}\n` +
        `mutations/5s ${dbg.mutations.length}`;
      el.style.color = dbg.worst > 100 ? '#f14c4c' : '#4ec9b0';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // Double-tap the readout area to reset `worst` between runs.
    let lastTap = 0;
    window.addEventListener('touchend', () => {
      const t = Date.now();
      if (t - lastTap < 350) dbg.worst = 0;
      lastTap = t;
    });
  });
})();
