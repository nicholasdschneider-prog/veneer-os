import { ChevronDown } from 'lucide-react';

function promptPreview(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function PromptDisclosure({ text }: { text: string }) {
  const lineCount = text.split('\n').length;
  const size = `${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'} · ${text.length.toLocaleString()} characters`;
  return (
    <details data-prompt-disclosure className="group/prompt min-w-0">
      <summary
        className="flex min-w-0 cursor-pointer list-none items-start gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        title={size}
      >
        <span className="min-w-0 flex-1 line-clamp-3 whitespace-normal break-words group-open/prompt:hidden">
          {promptPreview(text)}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 pt-0.5 text-xs font-medium text-muted-foreground">
          <span className="group-open/prompt:hidden">Show</span>
          <span className="hidden group-open/prompt:inline">Hide</span>
          <span className="hidden sm:inline" aria-hidden="true">· {size}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/prompt:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <div data-prompt-disclosure-body className="mt-2 border-t pt-2 whitespace-pre-wrap">{text}</div>
    </details>
  );
}
