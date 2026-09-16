import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Probe /api/me until the freshly-restarted server answers, then reload so the
// whole app (WS included) reconnects cleanly. Tolerant of the connection being
// refused/hung mid-restart — each attempt has its own short timeout.
async function waitForServer(signal: AbortSignal): Promise<void> {
  const started = Date.now();
  // First give the old process a moment to actually exit before we start probing.
  await new Promise((r) => setTimeout(r, 1500));
  while (!signal.aborted && Date.now() - started < 90_000) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch('/api/me', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (res.ok) return;
    } catch {
      /* server still down — keep probing */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export function RestartButton() {
  const [confirm, setConfirm] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'timeout'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const doRestart = useCallback(async () => {
    setConfirm(false);
    setPhase('restarting');
    // The 202 may not arrive (server exits mid-response) — either way it restarts.
    await api.adminRestart().catch(() => undefined);
    const ctl = new AbortController();
    abortRef.current = ctl;
    await waitForServer(ctl.signal);
    if (ctl.signal.aborted) return;
    // Server answered — reload to re-establish the app + WS from scratch.
    window.location.reload();
    // If we somehow fall through (reload blocked), surface a manual path.
    setPhase('timeout');
  }, []);

  return (
    <>
      <Button
        variant="outline"
        onPointerUp={() => setConfirm(true)}
        className="h-11 w-full rounded-xl text-muted-foreground"
      >
        <span className="text-lg leading-none">⟳</span> Restart Veneer Pro
      </Button>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Restart Veneer Pro?</DialogTitle>
            <DialogDescription>
              This restarts the app to unstick it. Any reply in progress will stop, and it'll be
              back in a few seconds.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button className="h-11 flex-1 rounded-xl" onPointerUp={() => void doRestart()}>
              Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {phase !== 'idle' ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 px-8 text-center supports-backdrop-filter:backdrop-blur-sm">
          {phase === 'restarting' ? (
            <div className="flex flex-col items-center gap-4">
              <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <div>
                <p className="text-lg font-medium">Restarting…</p>
                <p className="mt-1 text-muted-foreground">Reconnecting when it's back.</p>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-lg font-medium">Taking longer than expected</p>
              <p className="mt-1 text-muted-foreground">The app should be back shortly.</p>
              <Button
                className="mt-5 h-11 rounded-xl px-5 text-base"
                onPointerUp={() => window.location.reload()}
              >
                Reload
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
