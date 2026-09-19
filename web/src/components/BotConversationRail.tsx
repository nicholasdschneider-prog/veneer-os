import { useEffect, useState } from 'react';
import { botsApi, type Bot } from '@/lib/bots';
import { BotAvatar, BotPresence } from './BotIdentity';
import { cn } from '@/lib/utils';

export function BotConversationRail({
  selectedId,
  onNavigate,
}: {
  selectedId?: string | null;
  onNavigate: (hash: string) => void;
}) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void botsApi
        .list('all')
        .then((result) => {
          if (active) {
            setBots(result.bots);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('Could not refresh bots');
        });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <aside aria-label="Bot conversations" className="flex h-full min-h-0 flex-col border-r bg-card">
      <div className="space-y-3 border-b p-4">
        <button className="text-lg font-semibold" onClick={() => onNavigate('#/bots')}>
          VeneerBots
        </button>
        <p className="text-xs text-muted-foreground">
          {bots.length} bots · Your existing conversations
        </p>
        <input
          aria-label="Find a bot"
          placeholder="Find a bot…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
        />
        <button
          className="text-sm text-primary underline"
          onClick={() => onNavigate('#/bots?register=1')}
        >
          Register an existing chat
        </button>
      </div>
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <nav aria-label="Bots" className="flex-1 overflow-y-auto p-2">
        {bots
          .filter((bot) =>
            `${bot.name} ${bot.title ?? ''}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((bot) => (
            <button
              key={bot.conversation_id}
              aria-current={selectedId === bot.conversation_id ? 'page' : undefined}
              onClick={() => onNavigate(`#/chat/${bot.conversation_id}?from=bots`)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
                selectedId === bot.conversation_id && 'bg-muted',
              )}
            >
              <BotAvatar id={bot.conversation_id} name={bot.name} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium">
                  <span className="truncate">{bot.name}</span>
                  {bot.unread && (
                    <span
                      aria-label="Unread messages"
                      className="size-2 shrink-0 rounded-full bg-primary"
                    />
                  )}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {bot.title || 'Open conversation'}
                </span>
                <BotPresence id={bot.conversation_id} state={bot.state} />
                {bot.questions > 0 && (
                  <span className="block text-xs text-amber-600 dark:text-amber-300">
                    {bot.questions} raised {bot.questions === 1 ? 'hand' : 'hands'}
                  </span>
                )}
                {bot.updated_at && (
                  <time
                    className="block text-[10px] text-muted-foreground"
                    dateTime={bot.updated_at}
                  >
                    {new Date(
                      bot.updated_at.includes('T')
                        ? bot.updated_at
                        : bot.updated_at.replace(' ', 'T') + 'Z',
                    ).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </time>
                )}
              </span>
            </button>
          ))}
        {!bots.length && !error && (
          <p className="p-3 text-sm text-muted-foreground">
            Register an existing chat to add your operational bots here.
          </p>
        )}
      </nav>
    </aside>
  );
}
