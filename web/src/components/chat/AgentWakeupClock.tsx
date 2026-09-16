import { Clock3 } from 'lucide-react';

/** Compact list marker; the detailed wake-up controls remain inside the chat. */
export function AgentWakeupClock({ active }: { active: boolean }) {
  if (!active) return null;
  const label = 'Agent has a scheduled wake-up';
  return (
    <span className="mr-1 inline-flex shrink-0" title={label} aria-label={label}>
      <Clock3 className="size-3" aria-hidden="true" />
    </span>
  );
}
