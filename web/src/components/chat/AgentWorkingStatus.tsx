import type { PointerEventHandler } from 'react';
import { AgentActivityOrb } from '../AgentActivityOrb';
import { Button } from '../ui/button';
import { Marker, MarkerContent } from '../ui/marker';

export function AgentWorkingMarker({
  thinking,
  compacting = false,
}: {
  thinking: boolean;
  compacting?: boolean;
}) {
  const state = thinking && !compacting ? 'searching' : 'solving';
  return (
    <Marker className="pt-0.5 pb-1">
      <MarkerContent className="shimmer flex items-center gap-1.5">
        <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
          <AgentActivityOrb
            state={state}
            size={64}
            style={{ width: 29, height: 29 }}
            data-orb-state={state}
          />
        </span>
        <span>{compacting ? 'Compacting context…' : thinking ? 'Thinking…' : 'Working…'}</span>
      </MarkerContent>
    </Marker>
  );
}

export function AgentWorkingStopButton({
  onPointerUp,
}: {
  onPointerUp: PointerEventHandler<HTMLButtonElement>;
}) {
  return (
    <Button
      size="icon-lg"
      variant="secondary"
      className="relative size-10 shrink-0 rounded-full"
      onPointerUp={onPointerUp}
      aria-label="Stop agent"
      title="Stop agent"
    >
      <AgentActivityOrb
        state="shaping"
        size={20}
        className="scale-110"
        data-orb-state="shaping"
        aria-hidden
      />
      <span
        className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
        aria-hidden
      />
    </Button>
  );
}
