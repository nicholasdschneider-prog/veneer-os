import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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
      <App />
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
