import type { ProviderState, SkillProviders } from '@/lib/skills';

function pillClass(state: ProviderState): string {
  if (state === 'ok') return 'text-brand ring-1 ring-brand/40 bg-brand/10';
  if (state === 'broken-link') return 'text-amber-700 dark:text-amber-300 ring-1 ring-amber-500/40 bg-amber-500/10';
  return 'text-muted-foreground/50 ring-1 ring-border';
}

function Pill({ label, state }: { label: string; state: ProviderState }) {
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${pillClass(state)}`}>{label}</span>
  );
}

/** Provider pills showing where a skill is currently available. */
export function ProviderBadges({ providers }: { providers: SkillProviders }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Pill label="Claude" state={providers.claude} />
      <Pill label="Codex" state={providers.codex} />
      <Pill label="Grok" state={providers.grok} />
    </span>
  );
}

/** A small amber dot indicating a skill needs attention (has issues). */
export function IssueBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
      aria-label={`${count} issue${count > 1 ? 's' : ''} to fix`}
      title={`${count} issue${count > 1 ? 's' : ''} to fix`}
    />
  );
}
