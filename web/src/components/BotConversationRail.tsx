import { isPeopleConversation } from '@/lib/teamRooms';
import { ChatUnread } from './ChatUnread';
import {NewGroupChat} from './NewGroupChat';
import {GroupConversationRow} from './GroupConversationRow';
import {useBotGroups,mergeBotGroups,botSections} from '@/lib/botGroups';
import { api } from '@/lib/api';
import { BusinessSelector, useBusinessSelection } from './BusinessSelector';
import type { BusinessTeam } from '@/lib/bots';
import { useEffect, useState } from 'react';
import { botsApi, type Bot } from '@/lib/bots';
import { BotAvatar, BotName, BotPresence } from './BotIdentity';
import { cn } from '@/lib/utils';
import { Hand, Users, Bot as BotIcon, ChevronDown } from 'lucide-react';
import { BotActions, BOT_PREFERENCES_CHANGED } from './BotActions';

export function BotConversationRail({
  selectedId,
  selectedGroup,
  restricted = false,
  onNavigate,
}: {
  selectedId?: string | null;
  selectedGroup?: string;
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
  const {groups,error:groupError}=useBotGroups(business,restricted);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('chats:sections') || '{}'); } catch { return {}; }
  });
  const toggle = (section: string) => setCollapsed(old => {
    const next = { ...old, [section]: !old[section] };
    try { localStorage.setItem('chats:sections', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    return next;
  });
  const people = groups.filter(isPeopleConversation);
  const botGroups = groups.filter(g => !isPeopleConversation(g));
  const peopleUnread = people.filter(g => g.unread > 0).length;
  const botUnread = bots.filter(b => b.unread).length + botGroups.filter(g => g.unread > 0).length;
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
    refresh();
    window.addEventListener(BOT_PREFERENCES_CHANGED, refresh);
    const timer = setInterval(() => {
      refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, refresh);
    };
  }, [business]);
  return (
    <aside aria-label="Chats" className="flex h-full min-h-0 flex-col border-r bg-card">
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between"><button className="text-lg font-semibold hover:underline" onClick={() => onNavigate('#/bots')} title="All chats">
          Chats
        </button><NewGroupChat business={business} onNavigate={onNavigate}/></div>
        {!restricted && <BusinessSelector teams={teams} business={business} onSelect={id => { select(id); onNavigate('#/bots'); }} />}
        <input
          aria-label="Find a person, bot, or group"
          placeholder="Find a person, bot, or group…"
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
      {(error || groupError) && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error || groupError}
        </p>
      )}
      <nav aria-label="Conversations" className="flex-1 overflow-y-auto p-2">
        <button className="flex min-h-12 w-full items-center gap-2 px-3 text-sm font-medium text-muted-foreground" aria-expanded={!collapsed.people || !!query} onClick={() => toggle('people')}>
          <Users className="size-4 text-blue-600 dark:text-blue-300" /> People
          <ChevronDown className={cn('size-4', collapsed.people && !query && '-rotate-90')} />
          <span className="ml-auto"><ChatUnread people={peopleUnread} bots={0} /></span>
        </button>
        {(!collapsed.people || query) && <div>
          {mergeBotGroups([], people, query).map(entry => entry.kind !== 'bot' && <GroupConversationRow key={entry.id} group={entry} selected={selectedGroup === 'room:' + entry.id} onNavigate={onNavigate} />)}
          {!people.length && <p className="px-3 pb-4 text-sm text-muted-foreground">Use + to start a chat with a teammate.</p>}
        </div>}
        <button className="mt-3 flex min-h-12 w-full items-center gap-2 px-3 text-sm font-medium text-muted-foreground" aria-expanded={!collapsed.bots || !!query} onClick={() => toggle('bots')}>
          <BotIcon className="size-4 text-violet-600 dark:text-violet-300" /> Bots
          <ChevronDown className={cn('size-4', collapsed.bots && !query && '-rotate-90')} />
          <span className="ml-auto"><ChatUnread people={0} bots={botUnread} /></span>
        </button>
        {(!collapsed.bots || query) && <div>
        {botSections(mergeBotGroups(bots,botGroups,query)).map(section => <div key={section.name}>
          <button className="flex min-h-11 w-full items-center gap-2 px-3 text-sm text-muted-foreground" aria-expanded={!collapsed['bot:' + section.name] || !!query} onClick={() => toggle('bot:' + section.name)}>
            {section.name}<ChevronDown className={cn('size-4', collapsed['bot:' + section.name] && !query && '-rotate-90')} />
            <span className="ml-auto"><ChatUnread people={0} bots={section.entries.filter(e => e.kind === 'bot' ? e.bot.unread : e.unread > 0).length} /></span>
          </button>
          {(!collapsed['bot:' + section.name] || query) && section.entries.map(entry => {
          if(entry.kind!=='bot')return <GroupConversationRow key={entry.kind+entry.id} group={entry} selected={selectedGroup===entry.kind+':'+entry.id} onNavigate={onNavigate}/>;
          const bot=entry.bot;
          return (
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
          );})}
        </div>)}
        {!bots.length && !groups.length && !error && (
          <p className="p-3 text-sm text-muted-foreground">
            {restricted ? 'No bots have been assigned to your account yet.' : 'Register an existing chat to add your operational bots here.'}
          </p>
        )}
        </div>}
        {/* The overview is where questions, follow-through and history live.
            Once a bot is open it is the only way back, so it gets a real row. */}
        <button
          aria-current={undefined}
          onClick={() => onNavigate('#/bots?view=work')}
          className={cn(
            'mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',

          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
            <Hand className="size-5 text-amber-600 dark:text-amber-300" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Bot work overview</span>
            <span className="block text-xs text-muted-foreground">Questions, follow-through, history</span>
          </span>
          {pendingQuestions > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-black tabular-nums">
              {pendingQuestions}
            </span>
          )}
        </button>
      </nav>
    </aside>
  );
}
