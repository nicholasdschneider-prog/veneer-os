import { decisionSection, decisionStatusLabel } from '@/lib/decisionPresentation';
import { BusinessAccess } from '@/components/BusinessAccess';
import { BusinessSelector, useBusinessSelection } from '@/components/BusinessSelector';
import type { BusinessTeam } from '@/lib/bots';
import { BotConversationRail } from '@/components/BotConversationRail';
import { BotAvatar, BotName, BotPresence } from '@/components/BotIdentity';
import { BotComposer } from '@/components/BotComposer';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
  onNavigate,
}: {
  decisionId?: string;
  registrationRequested?: boolean;
  /** Direct human sessions can call bots within their normal conversation access. */
  canCall?: boolean;
  onNavigate: (hash: string) => void;
}) {
  const currentRoute = useRef(decisionId);
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
  const { business, select } = useBusinessSelection();
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
    setLoading(false);
  }, [filter, decisionId, business]);
  useEffect(() => {
    let active = true;
    void refresh().catch((e) => {
      if (active) {
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
            setError(e.message);
            if (e.status === 403 || e.status === 404) setDetail(null);
          }
        });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
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
      ...body,
    });
  const needs = decisions.filter((d) => decisionSection(d) === 'input');
  // Wide screens with nothing open show the three groups side by side so all
  // of them scroll together; each column keeps its own heading pinned.
  const wide = useMediaQuery('(min-width: 1024px)');
  const columns = wide && !decisionId;
  const stickyHeader = columns ? 'sticky top-0 z-10 -mx-1 w-auto bg-background px-1 pt-1 pb-2' : undefined;
  const sections = [
    ['execution', 'Following through'],
    ['attention', 'Needs attention'],
    ['deferred', 'Deferred'],
    ['history', 'Completed / History'],
  ] as const;
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
      <div className="hidden w-72 shrink-0 md:block"><BotConversationRail selectedId={d?.conversation_id} onNavigate={onNavigate} /></div>
    <div className="h-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-10 sm:px-8">
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
            <div className="mt-2 h-[min(65dvh,32rem)] overflow-hidden rounded-xl border"><BotConversationRail selectedId={d?.conversation_id} onNavigate={onNavigate} /></div>
          </details>
          {teams.find(t => t.id === business && t.can_manage) && <BusinessAccess team={teams.find(t => t.id === business)!} onChanged={() => { void refresh(); }} />}
        </div>
        <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <BotIcon className="size-4" /> Your operational team
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              VeneerBots
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              A home for your ongoing work. Answer a question; your bot picks up
              where it left off.
            </p>
          </div>
          {teams.length === 0 && <Button
            className="min-h-11"
            variant="outline"
            onClick={openRegistration}
            disabled={busy}
          >
            <Plus className="mr-2 size-4" />
            Register a bot
          </Button>}
        </header>
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
            ['me', 'For me'],
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
            decisionId && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]',
          )}
        >
          <div className={cn('min-w-0', decisionId && 'hidden lg:block')}>
            {(() => {
              const byKey = (key: string) => decisions.filter((item) => decisionSection(item) === key);
              const card = (item: BotDecision) => (
                <DecisionCard
                  key={item.id}
                  d={item}
                  onOpen={() => onNavigate('#/bots/' + item.id)}
                  onCall={canCall ? () => liveVoice.open(item.conversation_id, item.id) : undefined}
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
                      <p className="font-medium">No questions waiting here</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Questions stay here until someone gives an explicit answer.
                      </p>
                    </div>
                  ) : (
                    <div className={cn('grid gap-3', !decisionId && !columns && 'md:grid-cols-2')}>
                      {needs.map(card)}
                    </div>
                  )}
                </section>
              );
              const historyNote = (
                <p className="mb-3 text-sm text-muted-foreground">Completed scoped tasks and closed proposals. Open any item to view its discussion, answer, evidence and audit. Completion does not close the wider case.</p>
              );
              if (!columns) {
                return (
                  <>
                    {inputSection}
                    {sections.map(([key, title]) => {
                      const items = byKey(key);
                      if (!items.length && key !== 'history') return null;
                      return (
                        <section key={key} className="mt-7" aria-label={title}>
                          <SectionToggle id={`section-${key}`} title={title} count={items.length} open={!collapsed[key]} onToggle={() => toggleSection(key)} />
                          {collapsed[key] ? null : (
                            <>
                              {key === 'history' && historyNote}
                              <div className="grid gap-3">{items.map(card)}</div>
                            </>
                          )}
                        </section>
                      );
                    })}
                  </>
                );
              }
              // Three columns: questions · attention (with follow-through and
              // deferred beneath) · history. Empty groups still show so the
              // headings stay in the same place from visit to visit.
              const attention = byKey('attention');
              const execution = byKey('execution');
              const deferred = byKey('deferred');
              const history = byKey('history');
              const middleCount = attention.length + execution.length + deferred.length;
              const subgroup = (title: string, items: BotDecision[]) =>
                items.length ? (
                  <div key={title}>
                    <h3 className="sticky top-12 z-10 -mx-1 bg-background px-1 py-2 text-sm font-medium text-muted-foreground">
                      {title} <span className="ml-1 text-xs">{items.length}</span>
                    </h3>
                    <div className="grid gap-3">{items.map(card)}</div>
                  </div>
                ) : null;
              const empty = (text: string) => (
                <p className="rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">{text}</p>
              );
              return (
                <div className="grid grid-cols-3 items-start gap-5">
                  {inputSection}
                  <section aria-label="Needs attention" className="min-w-0">
                    <SectionToggle id="section-attention" title="Needs attention" count={middleCount} open={!collapsed.attention} onToggle={() => toggleSection('attention')} className={stickyHeader} />
                    {collapsed.attention ? null : middleCount === 0 ? (
                      empty('Nothing needs attention right now.')
                    ) : (
                      <div className="grid gap-5">
                        {attention.length > 0 && <div className="grid gap-3">{attention.map(card)}</div>}
                        {subgroup('Following through', execution)}
                        {subgroup('Deferred', deferred)}
                      </div>
                    )}
                  </section>
                  <section aria-label="Completed / History" className="min-w-0">
                    <SectionToggle id="section-history" title="Completed / History" count={history.length} open={!collapsed.history} onToggle={() => toggleSection('history')} className={stickyHeader} />
                    {collapsed.history ? null : history.length === 0 ? (
                      empty('Completed work will collect here.')
                    ) : (
                      <>
                        {historyNote}
                        <div className="grid gap-3">{history.map(card)}</div>
                      </>
                    )}
                  </section>
                </div>
              );
            })()}
            <section className="mt-8" aria-labelledby="bot-roster">
              <SectionToggle id="bot-roster" title="Your bots" count={bots.length} open={!collapsed.bots} onToggle={() => toggleSection('bots')} />
              {collapsed.bots ? null : (
              <>
              {bots.length === 0 && !loading && (
                <p className="rounded-2xl border p-5 text-sm text-muted-foreground">
                  Register an existing operational chat to give it a place here.
                </p>
              )}
              <div className="divide-y rounded-2xl border bg-card">
                {bots.map((bot) => (
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
                      <BotName name={bot.name} title={bot.title} />
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
                ))}
              </div>
              </>
              )}
            </section>
          </div>
          {decisionId && (
            <section
              className="min-w-0 rounded-2xl border bg-card p-4 [overflow-wrap:anywhere] sm:p-5"
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
                        Talk with {d.bot_name} about this
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="min-h-11 flex-1 sm:flex-none"
                      onClick={() => onNavigate(sideChatHash(d.conversation_id, 'bots'))}
                    >
                      <MessageSquare className="size-4" />
                      Side chat with {d.bot_name}
                    </Button>
                  </div>
                  <h2 className="mt-4 text-xl font-semibold leading-snug">
                    {d.proposal.question}
                  </h2>
                  <p className="mt-2 break-all text-xs text-muted-foreground">
                    {d.id} · Proposal v{d.version}
                  </p>
                  <div className="mt-5 rounded-xl bg-muted/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recommendation
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {d.proposal.recommendation}
                    </p>
                    <p className="mt-3 text-sm font-medium">
                      {d.proposal.consequence}
                    </p>
                  </div>
                  <dl className="mt-4 grid gap-3 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Waiting on</dt>
                      <dd>
                        {d.assignee_name}
                        {d.proposal.team && ` · ${d.proposal.team}`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        Dependent action
                      </dt>
                      <dd>
                        {d.proposal.blocked_action}{' '}
                        <span className="text-muted-foreground">
                          · Blocks{' '}
                          {d.proposal.blocks_scope === 'task'
                            ? 'this task only'
                            : 'the whole workload'}
                        </span>
                      </dd>
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
                  {d.answer && (
                    <div className="mt-4 rounded-xl border p-3 text-sm">
                      <p className="font-medium">
                        {d.answer.action} ·{' '}
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
                  <div className="mt-6 border-t pt-5">
                    <h3 className="flex flex-wrap items-center gap-2 font-medium">
                      <MessageSquare className="size-4" />
                      Discussion with {d.bot_name}

                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Replies go to this bot’s existing conversation.
                    </p>
                    <div className="my-4 space-y-3">
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
                            · {when(m.created_at)}
                          </p>
                          <p className="whitespace-pre-wrap break-words">
                            {m.text}
                          </p>
                        </div>
                      ))}
                    </div>
                    <BotComposer
                      conversationId={d.conversation_id}
                      botName={d.bot_name}
                      busy={busy}
                      onSend={(text) =>
                        act(async () => {
                          await send(d.id, 'thread', { text });
                        })
                      }
                    />
                  </div>
                  {d.state === 'needs_input' &&
                    (d.can_answer ? (
                      <div className="mt-6 border-t pt-5">
                        <h3 className="font-medium">
                          Your decision · v{d.version}
                        </h3>
                        <label className="mt-3 block text-sm">
                          Answer or reasoning
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
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['approve', 'reject', 'defer', 'withdraw'].map(
                            (action) => (
                              <Button
                                key={action}
                                className="min-h-11"
                                variant={
                                  action === 'approve' ? 'default' : 'outline'
                                }
                                disabled={busy || stale || !answer.trim()}
                                onClick={() =>
                                  void act(async () => {
                                    await mutate('answer', {
                                      action,
                                      text: answer,
                                      scope,
                                    });
                                    setAnswer('');
                                  })
                                }
                              >
                                {action[0]!.toUpperCase() + action.slice(1)}
                              </Button>
                            ),
                          )}
                        </div>
                        <button
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
                        </button>
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
                        Only {d.assignee_name} can answer this proposal.
                      </p>
                    ))}
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
    </div>
    </div>
  );
}
export function DecisionCard({ d, onOpen, onCall }: { d: BotDecision; onOpen: () => void; onCall?: () => void }) {
  return (
    <div className="relative w-full min-w-0 rounded-2xl border bg-card [overflow-wrap:anywhere] transition-colors hover:border-foreground/30 focus-within:ring-2 focus-within:ring-ring">
      {onCall && (
        <Button
          variant="outline"
          size="icon-lg"
          className="absolute right-3 top-3 z-10 rounded-full"
          aria-label={`Talk with ${d.bot_name} about this`}
          title={`Talk with ${d.bot_name} about this`}
          onClick={(event) => { event.stopPropagation(); onCall(); }}
        >
          <Phone className="size-4" />
        </Button>
      )}
    <button
      onClick={onOpen}
      className="w-full min-w-0 rounded-2xl p-4 text-left focus-visible:outline-none"
    >
      <div className={cn('mb-3 flex flex-wrap items-center justify-between gap-2', onCall && 'pr-12')}>
        <span className="inline-flex items-center gap-2 text-sm font-medium"><BotAvatar id={d.conversation_id} name={d.bot_name} />{d.bot_name}</span>
        <State state={d.state} label={decisionStatusLabel(d)} />
      </div>
      <h3 className="font-medium leading-snug">{d.proposal.question}</h3>
      <p className="mt-2 text-sm">Task: {d.proposal.blocked_action}</p>
      {d.result && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{d.result.evidence}</p>}
      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
        {d.proposal.recommendation}
      </p>
      <p className="mt-3 text-sm font-medium">{d.proposal.consequence}</p>
      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{d.assignee_name}</span>
        <span>{when(d.created_at)}</span>
        <span>
          {d.proposal.deadline
            ? `Due ${new Date(d.proposal.deadline).toLocaleString()}`
            : 'No deadline'}
        </span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {d.proposal.blocks_scope === 'task'
          ? d.state === 'needs_input'
            ? 'One task waiting · Other work can continue'
            : 'Task scope'
          : d.state === 'needs_input'
            ? 'Whole workload waiting'
            : 'Workload scope'}{' '}
        · v{d.version}
      </p>
    </button>
    </div>
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
