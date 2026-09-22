import { openBotWorkflows } from './BotWorkflows';
import { useState, type ReactNode } from 'react';
import { Mail, MailOpen, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import { botsApi, type Bot } from '@/lib/bots';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';

export const BOT_PREFERENCES_CHANGED = 'veneer:bot-preferences-changed';

/** Both pointer context menus and the touch/keyboard menu use the same actions. */
export function BotActions({ bot, children, onMarkedUnread }: {
  bot: Bot;
  children: ReactNode;
  onMarkedUnread?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (patch: { pinned?: boolean; unread?: boolean }) => {
    setBusy(true);
    setError('');
    try {
      await botsApi.preferences(bot.conversation_id, patch);
      if (patch.unread) onMarkedUnread?.();
      window.dispatchEvent(new Event(BOT_PREFERENCES_CHANGED));
    } catch {
      setError('Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div onContextMenu={(event) => { event.preventDefault(); setOpen(true); }}>
      <div className="flex min-w-0 items-center">
        <div className="min-w-0 flex-1">{children}</div>
        <div className="flex shrink-0 flex-col items-center pr-1">
          {bot.pinned && <Pin aria-label="Pinned bot" className="size-3 fill-current text-muted-foreground" />}
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <button aria-label={`Actions for ${bot.name}`} disabled={busy} className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => openBotWorkflows(bot.conversation_id, bot.name)}>Bot settings and routines</DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => void change({ pinned: !bot.pinned })}>
                {bot.pinned ? <PinOff /> : <Pin />} {bot.pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={() => void change({ unread: !bot.unread })}>
                {bot.unread ? <MailOpen /> : <Mail />} Mark as {bot.unread ? 'read' : 'unread'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {error && <p role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
