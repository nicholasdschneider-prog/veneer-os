import { Sparkles, X } from 'lucide-react';
import type { SkillCommand } from '../../lib/skillCommands';

const DETAILS_ID = 'composer-skill-details';

export function ComposerSkillChip({
  command,
  open,
  onToggle,
}: {
  command: SkillCommand;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`About /${command.name}`}
      aria-expanded={open}
      aria-controls={DETAILS_ID}
      onPointerUp={onToggle}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggle();
      }}
      className="flex min-h-10 max-w-[45%] shrink-0 items-center gap-1.5 self-start rounded-md bg-brand/15 px-2.5 py-1.5 text-base font-medium text-brand hover:bg-brand/20 sm:text-sm"
    >
      <Sparkles className="size-4 shrink-0 stroke-current" />
      <span className="min-w-0 truncate">/{command.name}</span>
    </button>
  );
}

export function ComposerSkillDetails({
  command,
  provider,
  onClose,
  onRemove,
}: {
  command: SkillCommand;
  provider: string;
  onClose: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      id={DETAILS_ID}
      role="dialog"
      aria-label={`About /${command.name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="absolute bottom-full left-0 z-40 mb-1 w-[min(24rem,calc(100vw-2rem))] rounded-xl bg-popover p-3 shadow-md ring-1 ring-foreground/10"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">/{command.name}</p>
          <p className="mt-1 text-pretty text-base text-muted-foreground sm:text-sm">
            {command.description ?? 'No description provided.'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close skill details"
          onPointerUp={onClose}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onClose();
          }}
          className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground sm:size-8"
        >
          <X className="size-4 shrink-0 stroke-current" />
        </button>
      </div>
      <p className="mt-3 text-base text-muted-foreground sm:text-sm">
        {command.scopeLabel} · {provider}
      </p>
      <button
        type="button"
        onPointerUp={onRemove}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onRemove();
        }}
        className="mt-3 rounded-lg px-3 py-2 text-base font-medium text-destructive hover:bg-destructive/10 sm:text-sm"
      >
        Remove skill
      </button>
    </div>
  );
}
