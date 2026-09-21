import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceProvider } from './components/VoiceProvider';
import { App } from './App';
import { FloatingDesktopProvider } from './components/desktop/FloatingDesktop';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';
import { api } from './lib/api';
import { applyBrand } from './lib/brandTheme';
import { applyColorMode, applyTheme, getColorMode, getTheme } from './lib/theme';
import '@fontsource-variable/inter';
import './styles.css';

// index.html already set theme attributes pre-paint; this pass syncs browser
// chrome and self-heals if the inline script was stale.
applyTheme(getTheme());
applyColorMode(getColorMode());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FloatingDesktopProvider>
      <VoiceProvider><App /></VoiceProvider>
    </FloatingDesktopProvider>
    <PwaUpdatePrompt />
  </StrictMode>,
);

void api
  .pageBrand()
  .then((result) => applyBrand(result.brand))
  .catch(() => {
    /* logged-out boot keeps the last mirrored brand tint */
  });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

// Stale-shell recovery. A tab can boot from an index.html written before the
// last deploy (offline cache, a reload during a restart) whose hashed bundles
// are gone. Reload once so the browser fetches a shell that matches the
// server; the guard keeps a genuinely broken deploy from looping.
if (import.meta.env.PROD) {
  const RELOAD_KEY = 'vp-stale-shell-reload';
  const reloadOnce = (reason: string) => {
    try {
      if (sessionStorage.getItem(RELOAD_KEY)) return;
      sessionStorage.setItem(RELOAD_KEY, '1');
    } catch {
      return;
    }
    console.warn(`[veneer] ${reason}; reloading for a fresh app shell`);
    window.location.reload();
  };
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    reloadOnce('a code chunk failed to load');
  });
  window.addEventListener('load', () => {
    // styles.css defines --background on :root; an unstyled boot means the
    // stylesheet the shell named no longer exists on the server.
    if (!getComputedStyle(document.documentElement).getPropertyValue('--background').trim()) {
      reloadOnce('the stylesheet did not load');
    } else {
      try {
        sessionStorage.removeItem(RELOAD_KEY);
      } catch {
        /* storage unavailable */
      }
    }
  });
}
