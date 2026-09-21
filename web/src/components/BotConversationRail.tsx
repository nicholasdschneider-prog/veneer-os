import { api } from '@/lib/api';
import { BusinessSelector, useBusinessSelection } from './BusinessSelector';
import type { BusinessTeam } from '@/lib/bots';
import { useEffect, useState } from 'react';
import { botsApi, type Bot } from '@/lib/bots';
import { huddlesApi } from '@/lib/huddles';
import { BotAvatar, BotName, BotPresence } from './BotIdentity';
import { cn } from '@/lib/utils';
import { Hand, Users } from 'lucide-react';
import { BotActions, BOT_PREFERENCES_CHANGED } from './BotActions';

export function BotConversationRail({
  selectedId,
  restricted = false,
  onNavigate,
}: {
  selectedId?: string | null;
  restricted?: boolean;
  onNavigate: (hash: string) => void;
}) {
  const { business: savedBusiness, select } = useBusinessSelection();
  const business = restricted ? '' : savedBusiness;
  const [teams, setTeams] = useState<BusinessTeam[]>([]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void api.conversation(selectedId).then(r => { if (active && r.conversation.businessTeamId) select(r.conversation.businessTeamId); }).catch(() => {});
    return () => { active = false; };
  }, [selectedId]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [openHuddles, setOpenHuddles] = useState(0);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const pendingQuestions = bots.reduce((sum, bot) => sum + bot.questions, 0);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void botsApi
        .list('all', business)
        .then((result) => {
          if (active) {
            setBots(result.bots);
            setTeams(result.teams ?? []);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('Could not refresh bots');
        });
    const refreshHuddles = () =>
      void huddlesApi
        .list('open', business)
        .then((result) => {
          if (active) setOpenHuddles(result.huddles.length);
        })
        .catch(() => {});
    refresh();
    refreshHuddles();
    window.addEventListener(BOT_PREFERENCES_CHANGED, refresh);
    const timer = setInterval(() => {
      refresh();
      refreshHuddles();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, refresh);
    };
  }, [business]);
  return (
    <aside aria-label="Bot conversations" className="flex h-full min-h-0 flex-col border-r bg-card">
      <div className="space-y-3 border-b p-4">
        <button className="text-lg font-semibold hover:underline" onClick={() => onNavigate('#/bots')} title="Back to the VeneerBots overview">
          VeneerBots
        </button>
        {!restricted && <BusinessSelector teams={teams} business={business} onSelect={id => { select(id); onNavigate('#/bots'); }} />}
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
        {!restricted && teams.length === 0 && <button
          className="text-sm text-primary underline"
          onClick={() => onNavigate('#/bots?register=1')}
        >
          Register an existing chat
        </button>}
      </div>
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <nav aria-label="Bots" className="flex-1 overflow-y-auto p-2">
        {/* The overview is where questions, follow-through and history live.
            Once a bot is open it is the only way back, so it gets a real row. */}
        <button
          aria-current={!selectedId ? 'page' : undefined}
          onClick={() => onNavigate('#/bots')}
          className={cn(
            'mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
            !selectedId && 'bg-muted',
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
            <Hand className="size-5 text-amber-600 dark:text-amber-300" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Overview</span>
            <span className="block text-xs text-muted-foreground">Questions, follow-through, history</span>
          </span>
          {pendingQuestions > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-black tabular-nums">
              {pendingQuestions}
            </span>
          )}
        </button>
        {!restricted && (
          <button
            aria-current={window.location.hash.startsWith('#/huddles') ? 'page' : undefined}
            onClick={() => onNavigate('#/huddles')}
            className={cn(
              'mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
              window.location.hash.startsWith('#/huddles') && 'bg-muted',
            )}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Users className="size-5 text-primary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Huddles</span>
              <span className="block text-xs text-muted-foreground">Bots working together on one outcome</span>
            </span>
            {openHuddles > 0 && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary tabular-nums">
                {openHuddles}
              </span>
            )}
          </button>
        )}
        {bots
          .filter((bot) =>
            `${bot.name} ${bot.title ?? ''}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((bot) => (
            <BotActions key={bot.conversation_id} bot={bot} onMarkedUnread={() => {
              if (selectedId === bot.conversation_id) onNavigate('#/bots');
            }}>
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
                <span className="flex items-baseline gap-2">
                  <BotName name={bot.name} title={bot.title} />
                  {bot.unread && (
                    <span
                      aria-label="Unread messages"
                      className="size-2 shrink-0 rounded-full bg-primary"
                    />
                  )}
                </span>
                <BotPresence id={bot.conversation_id} state={bot.state} />
              {bot.membership && <span className="block text-xs text-muted-foreground">{bot.membership.role === 'coordinator' ? 'Fleet coordinator' : bot.membership.subteam ? `${bot.membership.subteam} · ${bot.membership.role === 'lead' ? 'Lead' : 'Team'}` : 'Specialist'}</span>}
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
            </BotActions>
          ))}
        {!bots.length && !error && (
          <p className="p-3 text-sm text-muted-foreground">
            {restricted ? 'No bots have been assigned to your account yet.' : 'Register an existing chat to add your operational bots here.'}
          </p>
        )}
      </nav>
    </aside>
  );
}
