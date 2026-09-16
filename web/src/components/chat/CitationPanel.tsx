import { ChevronLeft, ExternalLink, Quote, X } from 'lucide-react';
import type { Citation } from '../../lib/citations';
import { Button } from '../ui/button';

export function CitationPanel({
  citations,
  isDesktop,
  onClose,
}: {
  citations: Citation[];
  isDesktop: boolean;
  onClose: () => void;
}) {
  const label = `${citations.length} ${citations.length === 1 ? 'source' : 'sources'}`;
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-1 border-b border-border px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
        {!isDesktop ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full"
            onPointerUp={onClose}
            aria-label="Back to chat"
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate font-medium">Citations</p>
          <p className="text-xs text-muted-foreground">{label} from this answer</p>
        </div>
        {isDesktop ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            onPointerUp={onClose}
            aria-label="Close citations panel"
          >
            <X className="size-5" />
          </Button>
        ) : null}
      </header>
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {citations.map((citation) => (
          <li key={citation.number} className="rounded-xl border bg-card p-4">
            <div className="flex items-start gap-3">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
                {citation.number}
              </span>
              <div className="min-w-0 flex-1">
                <p className="wrap-break-word font-medium">{citation.title}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Quote className="size-3 shrink-0" />
                  <span className="truncate">{citation.site}</span>
                </p>
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
                >
                  Open source
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
