import { Button } from './button';
import { cn } from '../../lib/utils';

export type FilePreviewMode = 'rendered' | 'source';

export function FilePreviewModeToggle({
  value,
  onChange,
  renderedLabel = 'Rendered',
  sourceLabel = 'Source',
  className,
}: {
  value: FilePreviewMode;
  onChange: (value: FilePreviewMode) => void;
  renderedLabel?: string;
  sourceLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="File view"
      className={cn('flex shrink-0 items-center gap-0.5 rounded-lg border bg-background/80 p-0.5 text-xs', className)}
    >
      {([
        ['rendered', renderedLabel],
        ['source', sourceLabel],
      ] as const).map(([mode, label]) => (
        <Button
          key={mode}
          type="button"
          variant={value === mode ? 'secondary' : 'ghost'}
          size="xs"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className="h-6 rounded-md px-2"
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
