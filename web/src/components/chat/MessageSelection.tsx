import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Quote, X } from 'lucide-react';

export type MessageQuote = { text: string; role: string };

export function appendMessageQuote(text: string, quote: MessageQuote | null): string {
  if (!quote) return text;
  const context = `Quoted from ${quote.role} message:\n${quote.text.split('\n').map((line) => `> ${line}`).join('\n')}`;
  return text ? `${text}\n\n${context}` : context;
}

// Explicit content markers also survive the transcript's frozen HTML render.
export function selectedMessageQuote(selection: Selection | null, root: HTMLElement): MessageQuote | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const start = element(range.startContainer)?.closest<HTMLElement>('[data-message-quote]');
  const end = element(range.endContainer)?.closest('[data-message-quote]');
  if (!start || start !== end || !root.contains(start)) return null;
  const text = selection.toString().trim();
  return text ? { text, role: start.dataset.messageQuote || 'assistant' } : null;
}

export function MessageSelection({ rootRef, onAdd }: {
  rootRef: RefObject<HTMLDivElement | null>;
  onAdd: (quote: MessageQuote) => void;
}) {
  const [selected, setSelected] = useState<{ quote: MessageQuote; left: number; top: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      const quote = rootRef.current && selectedMessageQuote(selection, rootRef.current);
      if (!quote || !selection) { setSelected(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      setSelected({ quote,
        left: Math.max(left + 8, Math.min(rect.left, left + width - 144)),
        top: Math.max(top + 8, Math.min(rect.top > top + 52 ? rect.top - 48 : rect.bottom + 8, top + height - 48)),
      });
    };
    const dismiss = () => setSelected(null);
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerup', update);
    document.addEventListener('keydown', keydown);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.visualViewport?.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerup', update);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.visualViewport?.removeEventListener('resize', dismiss);
    };
  }, [rootRef]);
  if (!selected) return null;
  return createPortal(
    <button type="button" style={{ left: selected.left, top: selected.top }}
      className="fixed z-50 flex min-h-10 items-center gap-2 rounded-lg border border-border bg-popover px-3 text-sm text-popover-foreground shadow-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        onAdd(selected.quote);
        window.getSelection()?.removeAllRanges();
        setSelected(null);
      }}>
      <Quote className="size-4" aria-hidden="true" /> Add to chat
    </button>, document.body,
  );
}

export function ComposerQuote({ quote, onRemove }: { quote: MessageQuote; onRemove: () => void }) {
  return <div className="mx-2 mt-1 flex min-w-0 items-start gap-2 rounded-lg border-l-2 border-brand bg-background/50 p-2 text-sm" role="status">
    <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="text-xs text-muted-foreground">Quoted from {quote.role} message</div>
      <blockquote className="max-h-24 overflow-y-auto whitespace-pre-wrap wrap-break-word">{quote.text}</blockquote>
    </div>
    <button type="button" onClick={onRemove} aria-label="Remove quote" className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
      <X className="size-4" aria-hidden="true" />
    </button>
  </div>;
}
