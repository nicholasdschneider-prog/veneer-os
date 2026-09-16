import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/button';
import { SharpOrb } from '../AgentActivityOrb';

/** What the browser is doing while it starts, in the order it happens. */
export const BROWSER_STARTING_PHASES = [
  'Warming up Chrome',
  'Loading your saved logins',
  'Connecting the live view',
] as const;

const PHASE_MS = 2200;

/**
 * The moment between "Open browser" and the first frame. A large searching orb
 * (the same animation the chat list uses, drawn at 110px) with a slow pulse on
 * the headline and a hairline sweep along the bottom edge, so the panel feels
 * alive instead of showing a spinner.
 */
export function BrowserStartingState({
  headline = 'Starting your browser',
  onClose,
}: {
  headline?: string;
  /** When set, a close control sits top-right — the loading screen covers the
   *  panel's own close on mobile, so it has to carry its own way out. */
  onClose?: () => void;
}) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPhase((value) => (value + 1) % BROWSER_STARTING_PHASES.length), PHASE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
      role="status"
      aria-live="polite"
      data-testid="browser-starting"
    >
      {onClose ? (
        <Button
          className="absolute top-[calc(env(safe-area-inset-top)+0.25rem)] right-1.5 z-10 size-12"
          variant="ghost"
          size="icon"
          onPointerUp={onClose}
          aria-label="Close browser"
        >
          <X className="size-6 shrink-0" />
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </Button>
      ) : null}
      <span className="flex size-[110px] shrink-0 items-center justify-center" aria-hidden>
        <SharpOrb state="searching" cssSize={110} data-orb-state="searching" />
      </span>
      <p className="vp-browser-start-pulse text-[15px] font-semibold tracking-[0.01em] text-foreground">{headline}</p>
      <p className="min-h-[18px] text-[13px] text-muted-foreground">
        {BROWSER_STARTING_PHASES[phase]}
        <span className="vp-starting-ellipsis" aria-hidden>
          <span>.</span><span>.</span><span>.</span>
        </span>
      </p>
      <span className="vp-browser-start-hair" aria-hidden />
    </div>
  );
}
