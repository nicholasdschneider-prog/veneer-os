import { DecisionImages } from '../components/DecisionImages';
import { isPeopleConversation } from '@/lib/teamRooms';
import {NewGroupChat} from '@/components/NewGroupChat';
import {GroupConversationRow} from '@/components/GroupConversationRow';
import {useBotGroups,mergeBotGroups} from '@/lib/botGroups';
import { DecisionChoices } from '../components/DecisionChoices';
import { BotCommunication, VoiceBriefing } from '../components/BotCommunication';
import { BotGuideNotice } from '@/components/BotGuideNotice';
import { decisionCopy, decisionSection, decisionStatusLabel, discussionTimestamp } from '@/lib/decisionPresentation';
import { BusinessAccess } from '@/components/BusinessAccess';
import { BusinessSelector, useBusinessSelection } from '@/components/BusinessSelector';
import type { BusinessTeam } from '@/lib/bots';
import { BotConversationRail } from '@/components/BotConversationRail';
import { BotActions, BOT_PREFERENCES_CHANGED } from '@/components/BotActions';
import { BotAvatar, BotName, BotPresence, BotWorkingIndicator } from '@/components/BotIdentity';
import { BotOrderLink } from '@/components/BotOrderLink';
import { BotCaseTimeline } from '@/components/BotCaseTimeline';
import { BotProposalSummary } from '@/components/BotProposalSummary';
import { BotComposer } from '@/components/BotComposer';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bot as BotIcon,
  Check,
  ChevronDown,
  Hand,
  MessageSquare,
  Phone,
  Plus,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useLiveVoice } from '@/components/VoiceProvider';
import { sideChatHash } from '@/lib/sideChat';
import {
  botsApi,
  decisionLabel,
  type Bot,
  type BotDecision,
  type BotThread,
} from '@/lib/bots';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
const field =
  'w-full rounded-xl border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring';
const COLLAPSED_KEY = 'veneer:bots-collapsed';
/** Section heading that folds its body away; the choice sticks per device. */
function SectionToggle({
  id,
  title,
  count,
  icon,
  open,
  onToggle,
  className,
}: {
  id: string;
  title: string;
  count: number;
  icon?: ReactNode;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn('mb-3 flex min-h-10 w-full items-center gap-2 text-left', className)}
    >
      {icon}
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      <span className="rounded-full bg-muted px-2 text-sm text-muted-foreground">{count}</span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'ml-auto size-5 text-muted-foreground transition-transform',
          !open && '-rotate-90',
        )}
      />
      <span className="sr-only">{open ? 'Hide section' : 'Show section'}</span>
    </button>
  );
}
function when(value: string) {
  const date = new Date(
    value.includes('T') ? value : value.replace(' ', 'T') + 'Z',
  );
  const hours = Math.max(
    0,
    Math.floor((Date.now() - date.getTime()) / 3600000),
  );
  return hours < 1
    ? 'Less than an hour ago'
    : hours < 24
      ? `${hours}h ago`
      : `${Math.floor(hours / 24)}d ago`;
}
function State({ state, label }: { state: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2.5 py-1 text-xs font-medium',
        state === 'needs_input'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : state === 'failed' || state === 'blocked'
            ? 'bg-destructive/10 text-destructive'
            : state === 'verified_completed'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'bg-muted text-muted-foreground',
      )}
    >
      {label ?? decisionLabel(state)}
    </span>
  );
}
export function Bots({
  decisionId,
  registrationRequested = false,
  canCall = false,
  restricted = false,
  onNavigate,
}: {
  decisionId?: string;
  registrationRequested?: boolean;
  /** Direct human sessions can call bots within their normal conversation access. */
  canCall?: boolean;
  restricted?: boolean;
  onNavigate: (hash: string) => void;
}) {
  const currentRoute = useRef(decisionId);
  const queuePane = useRef<HTMLDivElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const [queueWidth, setQueueWidth] = useState(0);
  useEffect(() => {
    const pane = queuePane.current;
    if (!pane) return;
    const observer = new ResizeObserver(([entry]) => setQueueWidth(entry?.contentRect.width ?? 0));
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);
  const selectedOffset = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
    const queue = queuePane.current;
    if (queue && decisionId && selectedOffset.current !== null) {
      const card = queue.querySelector<HTMLElement>(`[data-decision-id="${CSS.escape(decisionId)}"]`);
      if (card) queue.scrollTop += card.getBoundingClientRect().top - queue.getBoundingClientRect().top - selectedOffset.current;
    }
    selectedOffset.current = null;
  }, [decisionId]);
  currentRoute.current = decisionId;
  const reviewedVersion = useRef<number | null>(null);
  const pendingRequests = useRef(new Map<string, string>());
  const send = async (
    id: string,
    kind: string,
    body: Record<string, unknown>,
  ) => {
    const fingerprint = JSON.stringify([id, kind, body]);
    const key = pendingRequests.current.get(fingerprint) ?? crypto.randomUUID();
    pendingRequests.current.set(fingerprint, key);
    const result = await botsApi.mutate(id, kind, {
      ...body,
      request_key: key,
    });
    pendingRequests.current.delete(fingerprint);
    return result;
  };
  const [stale, setStale] = useState(false);
  const { business: savedBusiness, select } = useBusinessSelection();
  const business = restricted ? '' : savedBusiness;
  const {groups,error:groupError}=useBotGroups(business,restricted);
  const [teams, setTeams] = useState<BusinessTeam[]>([]);
  const [filter, setFilter] = useState('me');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  const [bots, setBots] = useState<Bot[]>([]);
  const [decisions, setDecisions] = useState<BotDecision[]>([]);
  const [detail, setDetail] = useState<BotThread | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const liveVoice = useLiveVoice();
  const [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [candidates, setCandidates] = useState<
    { id: string; title: string | null }[]
  >([]);
  const [chatId, setChatId] = useState('');
  const [name, setName] = useState('');
  const [answer, setAnswer] = useState('');
  const [scope, setScope] = useState('this_case');
  const [editing, setEditing] = useState(false);
  const [recommendation, setRecommendation] = useState('');
  const [amendQuestion, setAmendQuestion] = useState('');
  const [amendConsequence, setAmendConsequence] = useState('');
  const [amendAction, setAmendAction] = useState('');
  const [activityUnavailable, setActivityUnavailable] = useState(false);
  const refresh = useCallback(async () => {
    const [list, thread] = await Promise.all([
      botsApi.list(filter, business),
      decisionId ? botsApi.detail(decisionId) : Promise.resolve(null),
    ]);
    if (currentRoute.current !== decisionId) return;
    if (
      thread &&
      reviewedVersion.current !== null &&
      reviewedVersion.current !== thread.decision.version
    ) {
      setAnswer('');
      setScope('this_case');
      setEditing(false);
    }
    reviewedVersion.current = thread?.decision.version ?? null;
    setStale(false);
    setBots(list.bots);
    setTeams(list.teams ?? []);
    setDecisions(list.decisions);
    setDetail(thread);
    setActivityUnavailable(false);
    setLoading(false);
  }, [filter, decisionId, business]);
  useEffect(() => {
    let active = true;
    const preferencesChanged = () => {
      void botsApi.list(filter, business)
        .then((list) => { if (active) setBots(list.bots); })
        .catch((e) => { if (active) setError(e.message); });
    };
    window.addEventListener(BOT_PREFERENCES_CHANGED, preferencesChanged);
    void refresh().catch((e) => {
      if (active) {
        setActivityUnavailable(true);
        setError(e.message);
        setLoading(false);
      }
    });
    const timer = setInterval(() => {
      void Promise.all([
        botsApi.list(filter, business),
        decisionId ? botsApi.detail(decisionId) : Promise.resolve(null),
      ])
        .then(([list, thread]) => {
          if (active && currentRoute.current === decisionId) {
            setActivityUnavailable(false);
            setBots(list.bots);
    setTeams(list.teams ?? []);
            setDecisions(list.decisions);
            if (thread && reviewedVersion.current === thread.decision.version)
              setDetail(thread);
            else if (thread) setStale(true);
          }
        })
        .catch((e) => {
          if (active) {
            setActivityUnavailable(true);
            setError(e.message);
            if (e.status === 403 || e.status === 404) setDetail(null);
          }
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, preferencesChanged);
    };
  }, [refresh, filter]);
  useEffect(() => {
    reviewedVersion.current = null;
    setStale(false);
    setAnswer('');
    setScope('this_case');
    setEditing(false);
    setDetail(null);
  }, [decisionId]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = (kind: string, body: Record<string, unknown>) =>
    send(decisionId!, kind, {
      expected_version: detail!.decision.version,
      ...((kind === 'answer' || kind === 'choice' || kind === 'handling') && detail!.decision.shared_queue ? { expected_handling_revision: detail!.decision.handling_revision } : {}),
      ...body,
    });
  const needs = decisions.filter((d) => decisionSection(d) === 'input');
  const wide = useMediaQuery('(min-width: 1024px)');
  const stickyHeader = wide ? 'sticky top-0 z-10 -mx-1 w-auto bg-background px-1 pt-1 pb-2' : undefined;
  const d = detail?.decision;
  const openRegistration = () =>
    void act(async () => {
      setCandidates((await botsApi.candidates()).conversations);
      setRegistering(true);
    });
  useEffect(() => {
    if (registrationRequested) openRegistration();
  }, [registrationRequested]);
  return (
    <div className="flex h-full min-h-0">
      <div className="hidden w-72 shrink-0 md:block"><BotConversationRail restricted={restricted} selectedId={d?.conversation_id} onNavigate={onNavigate} /></div>
    <div className="flex h-full min-h-0 min-w-0 flex-1 gap-4 overflow-hidden bg-background">
      {/* `relative` keeps the sr-only section labels (position: absolute)
          inside this scroll pane; otherwise they resolve against the shell's
          <main> and stretch the document by the pane's full scroll height. */}
      <div ref={queuePane} aria-label="Decision queues" className={cn('relative mx-auto h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-10 sm:px-6', decisionId ? 'hidden lg:block' : 'max-w-6xl')}>
        {/* One thin toolbar: business picker and conversation drawer on mobile,
            plus the access manager for owners. Everything opens in place so the
            page header stays near the top. */}
        <div className="mb-4 flex flex-wrap items-center gap-2 empty:hidden md:mb-3">
          <div className="md:hidden">
            <BusinessSelector compact teams={teams} business={business} onSelect={id => { select(id); onNavigate('#/bots'); }} />
          </div>
          <details className="[&[open]]:basis-full md:hidden">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium">
              <MessageSquare className="size-3.5" /> Conversations
            </summary>
            <div className="mt-2 h-[min(65dvh,32rem)] overflow-hidden rounded-xl border"><BotConversationRail restricted={restricted} selectedId={d?.conversation_id} onNavigate={onNavigate} /></div>
          </details>
          <span className="md:hidden"><NewGroupChat business={business} onNavigate={onNavigate}/></span>
          {teams.find(t => t.id === business && t.can_manage) && <BusinessAccess team={teams.find(t => t.id === business)!} onChanged={() => { void refresh(); }} />}
        </div>
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <BotIcon className="size-4" /> Your operational team
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Bot work overview
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              A home for your ongoing work. Answer a question; your bot picks up
              where it left off.
            </p>
          </div>
          {!restricted && teams.length === 0 && <Button
            className="min-h-11"
            variant="outline"
            onClick={openRegistration}
            disabled={busy}
          >
            <Plus className="mr-2 size-4" />
            Register a bot
          </Button>}
        </header>
        <BotGuideNotice onNavigate={onNavigate} />
        {stale && (
          <div role="alert" className="mb-4 rounded-xl border p-3 text-sm">
            This proposal has changed.{' '}
            <button className="underline" onClick={() => void act(refresh)}>
              Review the new version
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error}
            <button
              className="ml-3 underline"
              onClick={() => void act(refresh)}
            >
              Retry
            </button>
          </div>
        )}
        {registering && (
          <form
            className="mb-6 grid gap-3 rounded-2xl border bg-card p-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await botsApi.register(chatId, name, true);
                setRegistering(false);
              });
            }}
          >
            <div className="sm:col-span-2">
              <h2 className="font-medium">Register an existing chat</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Its history, model, and ownership stay with the same chat. You
                can return it to Chats at any time.
              </p>
            </div>
            <label className="grid gap-1 text-sm">
              Chat
              <select
                required
                className={field}
                value={chatId}
                onChange={(e) => {
                  setChatId(e.target.value);
                  setName(
                    candidates.find((c) => c.id === e.target.value)?.title ??
                      '',
                  );
                }}
              >
                <option value="">Choose your chat</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? c.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Bot name
              <input
                required
                maxLength={100}
                className={field}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <Button disabled={busy || !chatId || !name} type="submit">
                Register bot
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRegistering(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        <div
          className="mb-6 flex flex-wrap items-center gap-2"
          aria-label="Decision filters"
        >
          {[
            ['me', 'For me & shared'],
            ['team', 'My team'],
            ['all', 'All I can access'],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setFilter(value!)}
              aria-pressed={filter === value}
              className={cn(
                'min-h-10 rounded-full px-4 text-sm font-medium',
                filter === value
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
          <button
            aria-label="Refresh bots"
            onClick={() => void act(refresh)}
            className="ml-auto rounded-full p-3 text-muted-foreground"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
        <div
          className={cn(
            'grid gap-6',
          )}
        >
          <div className={cn('min-w-0', decisionId && 'hidden lg:block')}>
            {(() => {
              const background = decisions.filter(item => decisionSection(item) !== 'input');
              const blockers = background.filter(item => ['blocked','failed'].includes(item.state));
              const card = (item: BotDecision) => (
                <DecisionCard
                  key={item.id}
                  d={item}
                  selected={item.id === decisionId}
                  onOpen={() => {
                    const card = queuePane.current?.querySelector<HTMLElement>(`[data-decision-id="${CSS.escape(item.id)}"]`);
                    selectedOffset.current = card && queuePane.current ? card.getBoundingClientRect().top - queuePane.current.getBoundingClientRect().top : null;
                    onNavigate('#/bots/' + item.id);
                  }}
                  onCall={canCall ? () => liveVoice.open(item.conversation_id, item.id) : undefined}
                  busy={busy || stale}
                  onApprove={() =>
                    act(async () => {
                      let current = item;
                      if (current.shared_queue && !current.collaborative_answers && !current.handler_id && current.can_handle) {
                        const claimed = (await send(current.id, 'handling', {
                          expected_version: current.version,
                          expected_handling_revision: current.handling_revision,
                          action: 'claim',
                        })) as { decision: BotDecision };
                        current = claimed.decision;
                      }
                      await send(current.id, 'answer', {
                        expected_version: current.version,
                        ...(current.shared_queue ? { expected_handling_revision: current.handling_revision } : {}),
                        action: 'approve',
                        text: QUEUE_APPROVAL_NOTE,
                        scope: 'this_case',
                      });
                    })
                  }
                />
              );
              const inputSection = (
                <section aria-labelledby="raised-hands" className="min-w-0">
                  <SectionToggle
                    id="raised-hands"
                    title="Needs your input"
                    count={needs.length}
                    icon={<Hand className="size-5 text-amber-600 dark:text-amber-300" />}
                    open={!collapsed.input}
                    onToggle={() => toggleSection('input')}
                    className={stickyHeader}
                  />
                  {collapsed.input ? null : loading ? (
                    <p className="py-8 text-muted-foreground">Loading your team…</p>
                  ) : needs.length === 0 ? (
                    <div className="rounded-2xl border border-dashed p-6">
                      <Check className="mb-2 size-5 text-muted-foreground" />
                      <p className="font-medium">No raised hands</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Your input queue is clear. Bots may still be working or waiting; you can check Progress & history below.
                      </p>
                    </div>
                  ) : (
                    <div className={cn('grid gap-3', !decisionId && queueWidth >= 680 && 'grid-cols-2')}>
                      {needs.map(card)}
                    </div>
                  )}
                </section>
              );
              return (
                <>
                  {inputSection}
                  <details className="mt-7 rounded-2xl border p-4" aria-label="Progress & history">
                    <summary className="min-h-11 cursor-pointer py-2 font-medium">
                      Progress &amp; history <span className="ml-2 text-sm text-muted-foreground">{background.length}</span>
                      {blockers.length > 0 && <span className="ml-2 text-sm font-normal text-muted-foreground">· {blockers.length} blocked or failed</span>}
                    </summary>
                    <p className="mb-4 mt-2 text-sm text-muted-foreground">
                      These items are not waiting for another answer. Your previous directions still apply, including holds and rejections.
                      Blocked or failed work stays visible here; if a bot needs your help again, it must raise a clear new question above.
                      Older records may not explain the next step—open the discussion for context. Completed tasks do not necessarily close the wider case.
                    </p>
                    {background.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No other work in this view yet.</p> : (
                      <div className={cn('grid gap-3', !decisionId && queueWidth >= 680 && 'grid-cols-2')}>
                        {background.map(card)}
                      </div>
                    )}
                  </details>
                </>
              );
            })()}
            <section className="mt-8" aria-labelledby="bot-roster">
              <SectionToggle id="bot-roster" title="Your bots and groups" count={bots.length+groups.length} open={!collapsed.bots} onToggle={() => toggleSection('bots')} />
              {collapsed.bots ? null : (
              <>
              {bots.length === 0 && !groups.length && !loading && (
                <p className="rounded-2xl border p-5 text-sm text-muted-foreground">
                  Register an existing operational chat to give it a place here.
                </p>
              )}
              {groupError&&<p role="alert" className="p-3 text-sm text-destructive">{groupError}</p>}
              <div className="divide-y rounded-2xl border bg-card">
                {mergeBotGroups(bots,groups.filter(g => !isPeopleConversation(g))).map(entry=>{
                  if(entry.kind!=='bot')return <GroupConversationRow key={entry.kind+entry.id} group={entry} onNavigate={onNavigate}/>;
                  const bot=entry.bot;
                  return (
                  <BotActions key={bot.conversation_id} bot={bot}>
                  <div
                    key={bot.conversation_id}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
                  >
                    <BotAvatar id={bot.conversation_id} name={bot.name} />
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() =>
                        onNavigate(`#/chat/${bot.conversation_id}?from=bots`)
                      }
                    >
                      <span className="flex items-baseline gap-2">
                        <BotName name={bot.name} title={bot.title} />
                        {bot.unread && <span aria-label="Unread messages" className="size-2 shrink-0 rounded-full bg-primary" />}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {bot.archived ? 'Archived · ' : ''}
                        <BotPresence id={bot.conversation_id} state={bot.state} /> · {bot.questions} waiting{' '}
                        {bot.questions === 1 ? 'question' : 'questions'}
                      </span>
                    </button>
                    {canCall && !bot.archived ? (
                      <Button
                        variant="outline"
                        size="icon-lg"
                        className="rounded-full"
                        aria-label={`Talk with ${bot.name}`}
                        title={`Talk with ${bot.name}`}
                        onClick={() => liveVoice.open(bot.conversation_id)}
                      >
                        <Phone className="size-4" />
                      </Button>
                    ) : (
                      <ArrowUpRight className="size-4 text-muted-foreground" />
                    )}
                    {bot.can_manage && (
                      <button
                        className="col-span-2 col-start-2 justify-self-start text-xs text-muted-foreground underline sm:col-span-1 sm:col-start-auto"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            botsApi.register(
                              bot.conversation_id,
                              bot.name,
                              false,
                            ),
                          )
                        }
                      >
                        Return to Chats
                      </button>
                    )}
                  </div>
                  </BotActions>
                );})}
              </div>
              </>
              )}
            </section>
          </div>
        </div>
      </div>
          {decisionId && (
            <section
              ref={detailPane}
              className="conversation-surface h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain border-l bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
              aria-label="Decision thread"
            >
              <button
                className="mb-5 flex min-h-10 items-center gap-2 text-sm text-muted-foreground"
                onClick={() => onNavigate('#/bots')}
              >
                <ArrowLeft className="size-4" />
                All questions
              </button>
              {!d ? (
                <p>Loading decision…</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-sm font-medium"><BotAvatar id={d.conversation_id} name={d.bot_name} />{d.bot_name}</span>
                    <State state={d.state} label={decisionStatusLabel(d)} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {canCall && (
                      <Button
                        className="min-h-11 flex-1 sm:flex-none"
                        onClick={() => liveVoice.open(d.conversation_id, d.id)}
                      >
                        <Phone className="size-4" />
                        Call {d.bot_name}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="min-h-11 flex-1 sm:flex-none"
                      onClick={() => onNavigate(sideChatHash(d.conversation_id, 'bots'))}
                    >
                      <MessageSquare className="size-4" />
                      Side chat
                    </Button>
                  </div>
                  <h2 className="mt-4 text-xl font-semibold leading-snug">
                    {d.proposal.question}
                  </h2>
                  <BotOrderLink order={d.order_reference} />
                  <p role="status" className="mt-2 text-sm text-muted-foreground">
                    {d.state === 'needs_input' ? 'Approval still needed' :
                      d.answer?.action === 'approve' ? `${decisionStatusLabel(d)}${['decided', 'action_pending', 'running'].includes(d.state) ? ' · No further approval click needed.' : ''}` : decisionStatusLabel(d)}
                  </p>
                  <BotCommunication mode="briefing" key={`${d.id}:${d.version}`} conversationId={d.conversation_id} decisionId={d.id} version={d.version} />
                  <div className="mt-5"><BotProposalSummary key={`${d.id}:${d.version}`} decision={d} showIdentifiers /></div>
                  <p className="mt-3 text-sm text-muted-foreground">Approval scope: {d.proposal.blocks_scope === 'task' ? 'This task only. Other work can continue.' : 'This decision gates the bot’s whole workload.'}</p>
                  {d.state === 'needs_input' && d.shared_queue && (
                    <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border p-3">
                      <p className="text-sm">{d.collaborative_answers ? 'Shared question: any already-authorized teammate can answer. Comments and handling do not reserve it; the first valid answer is recorded.' : d.handler_name ? `${d.handler_name} is handling this` : 'Any authorized teammate can approve this proposal. An extra owner approval click is not required.'}</p>
                      {!d.collaborative_answers && !d.handler_id && d.can_handle && <Button disabled={busy || stale} onClick={() => void act(() => mutate('handling', { action: 'claim' }))}>Handle this</Button>}
                      {d.can_release && <Button variant="outline" disabled={busy || stale} onClick={() => void act(() => mutate('handling', { action: 'release' }))}>Release question</Button>}
                    </div>
                  )}
                  <DecisionImages key={`${d.id}-${d.version}`} decision={d} />
                  {d.state === 'needs_input' &&
                    (d.can_answer ? (
                      <div className="mt-6 border-t pt-5">
                        <h3 className="font-medium">
                          Your decision · v{d.version}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">Applies to: {scope === 'this_case' ? 'This case only' : 'Standing rule intent — existing approvals still apply'}</p>
                        <DecisionChoices choices={d.proposal.choices} disabled={busy || stale} onChoose={choice_id => void act(async () => {
                          await mutate('choice', { choice_id, note: answer, scope });
                          setAnswer('');
                        })} />
                        <details className="mt-3"><summary className="min-h-11 cursor-pointer py-2 text-sm">Add a note or change scope</summary>
                        <label className="block text-sm">
                          Note
                          <textarea
                            className={cn(field, 'mt-1')}
                            rows={3}
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                          />
                        </label>
                        <label className="mt-3 block text-sm">
                          Applies to
                          <select
                            className={cn(field, 'mt-1')}
                            value={scope}
                            onChange={(e) => setScope(e.target.value)}
                          >
                            <option value="this_case">This case only</option>
                            <option value="standing_rule">
                              Standing rule (record intent)
                            </option>
                          </select>
                        </label>
                        {scope === 'standing_rule' && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            This records your intent. Existing policy and
                            financial approvals still apply.
                          </p>
                        )}

                        </details>
                        {d.can_amend !== false && !restricted && <button
                          className="mt-4 text-sm underline"
                          onClick={() => {
                            setEditing(!editing);
                            setRecommendation(d.proposal.recommendation);
                            setAmendQuestion(d.proposal.question);
                            setAmendConsequence(d.proposal.consequence);
                            setAmendAction(d.proposal.blocked_action);
                          }}
                        >
                          Amend proposal
                        </button>}
                        {editing && (
                          <div className="mt-3 space-y-3">
                            <label className="block text-sm">
                              Question
                              <textarea
                                className={field}
                                value={amendQuestion}
                                onChange={(e) =>
                                  setAmendQuestion(e.target.value)
                                }
                              />
                            </label>
                            <label className="block text-sm">
                              Revised recommendation
                              <textarea
                                className={cn(field, 'mt-1')}
                                value={recommendation}
                                onChange={(e) =>
                                  setRecommendation(e.target.value)
                                }
                              />
                            </label>
                            <label className="block text-sm">
                              Amount or consequence
                              <textarea
                                className={field}
                                value={amendConsequence}
                                onChange={(e) =>
                                  setAmendConsequence(e.target.value)
                                }
                              />
                            </label>
                            <label className="block text-sm">
                              Dependent action
                              <textarea
                                className={field}
                                value={amendAction}
                                onChange={(e) => setAmendAction(e.target.value)}
                              />
                            </label>
                            <Button
                              className="mt-2 min-h-11"
                              disabled={
                                busy ||
                                !recommendation.trim() ||
                                !amendQuestion.trim() ||
                                !amendConsequence.trim() ||
                                !amendAction.trim()
                              }
                              onClick={() =>
                                void act(async () => {
                                  await mutate('proposal', {
                                    proposal: {
                                      ...d.proposal,
                                      recommendation,
                                      question: amendQuestion,
                                      consequence: amendConsequence,
                                      blocked_action: amendAction,
                                    },
                                  });
                                  setEditing(false);
                                })
                              }
                            >
                              Save new version
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="mt-5 rounded-xl bg-muted p-3 text-sm">
                        {d.shared_queue ? (d.handler_name ? 'The current handler can submit the answer. You can both join the discussion.' : 'Choose Handle this before submitting an answer.') : `Only ${d.assignee_name} can answer this proposal.`}
                      </p>
                    ))}
                  {d.answer && (
                    <div className="mt-4 rounded-xl border p-3 text-sm">
                      <p className="font-medium">
                        <Check className="mr-2 inline size-4 text-emerald-500" aria-label="Answer recorded" />{d.answer.choice_label ?? d.answer.action} ·{' '}
                        {d.answer.scope === 'this_case'
                          ? 'This case only'
                          : 'Standing rule requested'}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap">
                        {d.answer.text}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Recorded answer; execution is tracked separately.
                      </p>
                      {!d.dismissed && (
                        <button
                          className="mt-3 underline"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              botsApi.mutate(d.id, 'dismiss', {
                                expected_version: d.version,
                              }),
                            )
                          }
                        >
                          Dismiss from my input queue
                        </button>
                      )}
                      {d.dismissed && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Dismissed from your input queue. Execution remains
                          visible.
                        </p>
                      )}
                    </div>
                  )}
                  {d.result && (
                    <div className="mt-4 rounded-xl border p-3 text-sm">
                      <State state={d.result.state} />
                      <p className="mt-2 whitespace-pre-wrap">
                        {d.result.evidence}
                      </p>
                    </div>
                  )}
                  {d.parked && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Work parked: {d.parked.evidence}
                    </p>
                  )}
                  <div className="mt-5"><BotCommunication mode="drafts" key={`drafts-${d.id}:${d.version}`} conversationId={d.conversation_id} decisionId={d.id} version={d.version} /></div>
                  <details className="mt-5 rounded-2xl border px-4">
                    <summary className="min-h-11 cursor-pointer py-3 font-medium">Case history, evidence & details</summary>
                    <BotCaseTimeline entries={d.proposal.case_timeline} />
                  <dl className="mt-4 grid gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">{d.answer ? 'Answered by' : 'Handling'}</dt>
                      <dd>
                        {d.answered_by ? `Answered by ${d.answered_by}` : d.shared_queue ? (d.handler_name ? `${d.handler_name} is handling this` : 'Shared queue · Available') : d.assignee_name}
                        {d.proposal.team && ` · ${d.proposal.team}`}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium">Approval scope</dt>
                      <dd className="text-muted-foreground">{d.proposal.blocks_scope === 'task' ? 'This approval applies to one task. Other work can continue.' : 'This decision gates the bot’s whole workload.'}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Timing</dt>
                      <dd>
                        {when(d.created_at)} ·{' '}
                        {d.proposal.deadline
                          ? `Due ${new Date(d.proposal.deadline).toLocaleString()}`
                          : 'No deadline'}
                      </dd>
                    </div>
                  </dl>
                  {d.proposal.evidence.length > 0 && (
                    <div className="mt-4">
                      <h3 className="text-sm font-medium">
                        Evidence & context
                      </h3>
                      {d.proposal.evidence.map((e, i) => (
                        <a
                          key={i}
                          href={`#/chat/${e.conversation_id}?from=bots`}
                          className="mt-2 block text-sm underline"
                        >
                          {e.label} ↗
                        </a>
                      ))}
                    </div>
                  )}
                  </details>
                  <div className="mt-6 border-t pt-5">
                    <h3 className="flex flex-wrap items-center gap-2 font-medium">
                      <MessageSquare className="size-4" />
                      Discussion with {d.bot_name}

                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Clear directions here can record your decision without another click. Questions stay in discussion; the bot will clarify ambiguous instructions.
                    </p>
                    <div className="my-4 space-y-3" id="decision-discussion">
                      {detail?.messages.map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            'rounded-xl p-3 text-sm',
                            m.actor_conversation_id ? 'bg-muted/60' : 'border',
                          )}
                        >
                          <p className="mb-1 text-xs font-medium text-muted-foreground">
                            {m.actor_conversation_id
                              ? d.bot_name
                              : m.actor_name}{' '}
                            · <time dateTime={m.created_at.replace(" ", "T") + (/[zZ]|[+-]\d\d:\d\d$/.test(m.created_at) ? "" : "Z")}>{discussionTimestamp(m.created_at)}</time>
                          </p>
                          <p className="whitespace-pre-wrap break-words">
                            {m.text}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mb-3"><BotWorkingIndicator name={d.bot_name} replyStatus={d.reply_status} unavailable={activityUnavailable || stale} /></div>
                    <div className="flex justify-end"><button type="button" aria-label="Jump to latest discussion" className="mb-2 flex size-11 items-center justify-center rounded-full border bg-background" onClick={() => document.getElementById('decision-composer')?.scrollIntoView({block:'end',behavior:'instant'})}>↓</button></div>
                    <div id="decision-composer"><BotComposer
                      key={d.id}
                      conversationId={d.conversation_id}
                      botName={d.bot_name}
                      decisionId={d.id}
                      busy={busy || stale}
                      onSend={(text) =>
                        act(async () => {
                          await send(d.id, 'thread', { text, expected_version: d.version });
                        })
                      }
                    /></div>
                  </div>
                  <details className="mt-6 border-t pt-4">
                    <summary className="cursor-pointer text-sm text-muted-foreground">
                      Decision history
                    </summary>
                    <ol className="mt-3 space-y-3">
                      {detail?.events.map((e) => (
                        <li key={e.id} className="text-xs">
                          <p className="font-medium">
                            {e.kind} · v{e.version} · User {e.actor_id} ·{' '}
                            {when(e.created_at)}
                          </p>
                          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-muted-foreground">
                            {JSON.stringify(
                              JSON.parse(e.payload_json),
                              null,
                              2,
                            )}
                          </pre>
                        </li>
                      ))}
                    </ol>
                  </details>
                </>
              )}
            </section>
          )}
      </div>
    </div>
  );
}
/** Recorded as the answer text when a proposal is approved straight from the queue card. */
export const QUEUE_APPROVAL_NOTE = 'Approved as proposed.';

/** One-click approval is offered when the viewer can answer now, or can claim a shared question and then answer it. */
export function canApproveFromQueue(d: BotDecision) {
  return !d.proposal.message_delivery && !d.proposal.choices?.length && d.state === 'needs_input' && (d.can_answer || Boolean(d.shared_queue && !d.handler_id && d.can_handle));
}

export function DecisionCard({ d, onOpen, onCall, onApprove, busy = false, selected = false }: { d: BotDecision; selected?: boolean; busy?: boolean; onOpen: () => void; onCall?: () => void; onApprove?: () => void }) {
  const quickApprove = onApprove && canApproveFromQueue(d);
  const hasDraft = Boolean(decisionCopy(d.proposal).draft);
  // First tap arms the button; a second tap within a few seconds sends. Guards against stray taps on a phone.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 8000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => { setArmed(false); }, [d.id, d.version]);
  return (
    <article data-decision-id={d.id} aria-current={selected ? "true" : undefined} className={cn("min-w-0 rounded-2xl border p-4 [overflow-wrap:anywhere]", selected ? "border-blue-500 bg-blue-100 dark:bg-blue-900 ring-2 ring-blue-500" : "bg-card")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium"><BotAvatar id={d.conversation_id} name={d.bot_name} />{d.bot_name}</div>
        <div className="flex items-center gap-2">
          <State state={d.state} label={decisionStatusLabel(d)} />
          {selected && <span className="text-sm font-semibold text-blue-700 dark:text-blue-200">Selected</span>}
          {onCall && <Button variant="outline" size="icon-lg" className="rounded-full" aria-label={`Talk with ${d.bot_name} about this`} onClick={onCall}><Phone className="size-4" /></Button>}
        </div>
      </div>
      <BotOrderLink order={d.order_reference} />
      <h3 className="mt-4 text-base font-semibold text-balance">
        <button onClick={onOpen} className="w-full rounded text-left hover:underline focus-visible:outline focus-visible:outline-ring">{d.proposal.question}</button>
      </h3>
      <VoiceBriefing key={`${d.id}:${d.version}`} decisionId={d.id} version={d.version} />
      <div className="mt-4"><BotProposalSummary decision={d} compact /></div>
      {d.result && <div className="mt-3 space-y-1 text-base sm:text-sm"><p className="font-medium">Latest update</p><p className="whitespace-pre-wrap text-pretty text-muted-foreground">{d.result.evidence}</p></div>}
      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{d.answered_by ? `Answered by ${d.answered_by}` : d.shared_queue ? (d.handler_name ? `With ${d.handler_name}` : 'Available for a teammate') : `For ${d.assignee_name}`}</span>
        <span>{when(d.created_at)}</span>
        {d.proposal.deadline && <span>Due {new Date(d.proposal.deadline).toLocaleString()}</span>}
      </div>
      {d.state === 'needs_input' && <p className="mt-2 text-sm text-muted-foreground">{d.proposal.blocks_scope === 'task' ? 'Other work can continue while this waits.' : 'All work for this bot is waiting for an answer.'}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {quickApprove && !armed && (
          <Button className="min-h-[44px] h-auto min-w-0 flex-[1_1_14rem] whitespace-normal py-2" disabled={busy} onClick={() => setArmed(true)}>
            {hasDraft ? 'Approve & send reply' : 'Approve as proposed'}
          </Button>
        )}
        {quickApprove && armed && (
          <div className="flex min-w-0 flex-[1_1_18rem] flex-wrap gap-2" role="group" aria-label="Confirm approval">
            <Button className="min-h-[44px] h-auto min-w-0 flex-[1_1_12rem] whitespace-normal bg-green-700 py-2 text-white hover:bg-green-800" disabled={busy} onClick={() => { setArmed(false); onApprove(); }}>
              {hasDraft ? 'Tap again to send' : 'Tap again to approve'}
            </Button>
            <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={() => setArmed(false)}>Cancel</Button>
          </div>
        )}
        <Button variant="outline" className="min-h-[44px] h-auto min-w-0 flex-[1_1_14rem] whitespace-normal py-2" onClick={onOpen}>{d.state === 'needs_input' ? 'Review & decide' : 'View decision'}</Button>
      </div>
    </article>
  );
}

function auditText(payload: string) {
  const value = JSON.parse(payload);
  if (typeof value === 'string') return value;
  const p = value.proposal ?? value;
  return [
    p.action,
    p.question,
    p.recommendation,
    p.consequence,
    p.blocked_action,
    p.text,
    p.evidence && typeof p.evidence === 'string' ? p.evidence : null,
    p.scope === 'standing_rule'
      ? 'Standing rule requested (existing authority unchanged)'
      : p.scope === 'this_case'
        ? 'This case only'
        : null,
  ]
    .filter(Boolean)
    .join('\n');
}
