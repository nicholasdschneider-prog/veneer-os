import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CHECK_INTERVAL_MS = 60_000;

function assetSignature(page: Document): string | null {
  const paths = [
    ...Array.from(page.querySelectorAll<HTMLScriptElement>('script[type="module"][src*="/assets/"]')).map(
      (script) => new URL(script.getAttribute('src')!, window.location.origin).pathname,
    ),
    ...Array.from(page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/"]')).map(
      (link) => new URL(link.getAttribute('href')!, window.location.origin).pathname,
    ),
  ].sort();
  return paths.length ? paths.join('|') : null;
}

function assetSignatureFromHtml(html: string): string | null {
  return assetSignature(new DOMParser().parseFromString(html, 'text/html'));
}

/** Detects a newly deployed Vite bundle without needing browser refresh chrome. */
export function PwaUpdatePrompt() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const currentAssets = assetSignature(document);
    if (!currentAssets) return;

    let stopped = false;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (stopped || checking) return;
      checking = true;
      try {
        const response = await fetch(`/?vp-bundle-check=${Date.now()}`, {
          cache: 'no-store',
          headers: { accept: 'text/html' },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const nextAssets = assetSignatureFromHtml(await response.text());
        if (!stopped && nextAssets && nextAssets !== currentAssets) {
          stopped = true;
          setAvailable(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) console.debug('[pwa-update] bundle check failed', error);
      } finally {
        checking = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check();
    };

    void check();
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  if (!available) return null;
  return <PwaUpdateBanner />;
}

export function PwaUpdateBanner() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+1.75rem)] z-50 flex justify-center pr-[calc(env(safe-area-inset-right)+1rem)] pl-[calc(env(safe-area-inset-left)+1rem)] md:top-[calc(env(safe-area-inset-top)+0.75rem)]">
      <div className="pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg">
        <span>A Veneer update is ready.</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-1 h-8 shrink-0 rounded-full px-2 text-background hover:bg-background/10 hover:text-background"
          onPointerUp={() => window.location.reload()}
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>
    </div>
  );
}
