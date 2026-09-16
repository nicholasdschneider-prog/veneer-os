import { BookOpen } from 'lucide-react';
import { citationPayload, type Citation } from '../../lib/citations';

export function CitationChip({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  const label = `${citations.length} ${citations.length === 1 ? 'citation' : 'citations'}`;
  return (
    <button
      type="button"
      data-citations-trigger=""
      data-citations={citationPayload(citations)}
      aria-label={`Open ${label}`}
      title={`Open ${label}`}
      className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <BookOpen className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}
