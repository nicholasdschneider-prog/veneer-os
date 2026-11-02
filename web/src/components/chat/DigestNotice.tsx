import { Markdown } from '../Markdown';
import { Button } from '@/components/ui/button';

/** A bot's scheduled digest in its human chat: a readable markdown block with
 * a link to the bot lane it came from, not the muted one-line notice. */
export function DigestNotice({ message, onView }: { message: string; onView?: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
      <Markdown markdown={message} mode="static" />
      {onView ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="ghost" onClick={onView}>
            View
          </Button>
        </div>
      ) : null}
    </div>
  );
}
