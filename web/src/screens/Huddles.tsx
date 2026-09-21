import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Lock, Plus, RefreshCw, Users, UserPlus } from 'lucide-react';
import { BotConversationRail } from '@/components/BotConversationRail';
import { BotAvatar } from '@/components/BotIdentity';
import { BusinessSelector, useBusinessSelection } from '@/components/BusinessSelector';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { botsApi, type BusinessTeam } from '@/lib/bots';
import {
  huddlesApi,
  huddleStatusLabel,
  mentionTargets,
  type Huddle,
  type HuddleAction,
  type HuddleMessage,
  type HuddleParticipant,
  type HuddleSummary,
} from '@/lib/huddles';
import { cn } from '@/lib/utils';

const field =
  'w-full rounded-xl border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function when(value: string | null): string {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function clock(value: string): string {
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function StatusPill({ huddle }: { huddle: Pick<HuddleSummary, 'status'> }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
        huddle.status === 'open' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground',
      )}
    >
      {huddle.status === 'open' ? <Users className="size-3" /> : <Lock className="size-3" />}
      {huddle.status === 'open' ? 'Open' : 'Closed'}
    </span>
  );
}

function ActionPill({ status }: { status: HuddleAction['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium',
        status === 'done'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : status === 'blocked'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : status === 'cancelled'
              ? 'bg-muted text-muted-foreground line-through'
              : 'bg-primary/10 text-primary',
      )}
    >
      {status}
    </span>
  );
}

/** One message row. Authorship is always explicit: a bot, a person, or Veneer itself. */
export function HuddleMessageRow({ message, names }: { message: HuddleMessage; names: Map<string, string> }) {
  const system = message.kind === 'system';
  const authorId = message.author.conversation_id;
  const targets = message.targets.map((t) => names.get(t) ?? t);
  return (
    <li
      data-kind={message.kind}
      className={cn('flex gap-3', system && 'text-sm text-muted-foreground')}
    >
      {authorId ? (
        <BotAvatar id={authorId} name={message.author.name} />
      ) : (
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold', system ? 'bg-muted' : 'bg-primary/10 text-primary')}>
          {system ? '·' : message.author.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn('font-medium', !system && 'text-foreground')}>{message.author.name}</span>
          {message.author.user_id !== null && <span className="text-xs text-muted-foreground">person</span>}
          {message.kind === 'handoff' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <ArrowRight className="size-3" /> handoff{targets.length ? ` to ${targets.join(', ')}` : ''}
            </span>
          )}
          {message.kind === 'status' && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">status</span>}
          {message.kind === 'message' && targets.length > 0 && (
            <span className="text-xs text-muted-foreground">to {targets.join(', ')}</span>
          )}
          <time dateTime={message.created_at} className="ml-auto text-[11px] text-muted-foreground" title={clock(message.created_at)}>
            #{message.seq} · {when(message.created_at)}
          </time>
        </div>
        <div className={cn('mt-0.5 [overflow-wrap:anywhere]', system ? 'whitespace-pre-wrap' : 'text-sm')}>
          {system ? message.body : <Markdown markdown={message.body} />}
        </div>
      </div>
    </li>
  );
}

function NewHuddleForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [bots, setBots] = useState<HuddleParticipant[]>([]);
  const [goal, setGoal] = useState('');
  const [why, setWhy] = useState('');
  const [lead, setLead] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void huddlesApi.candidates().then((r) => setBots(r.bots)).catch((e: Error) => setError(e.message));
  }, []);
  const toggle = (id: string) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const chosen = lead || members[0] || '';
      const result = await huddlesApi.open({ goal, why, lead: chosen, members: members.filter((m) => m !== chosen) });
      onCreated(result.huddle.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mb-6 grid gap-3 rounded-2xl border bg-card p-4" aria-label="New huddle">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">Goal</span>
        <input className={field} required minLength={8} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="One outcome, e.g. Resolve order 1234 replacement and refund" />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">Why a huddle</span>
        <textarea className={field} required minLength={8} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What makes this sustained shared work rather than one direct message" />
      </label>
      <fieldset className="grid gap-2 text-sm">
        <legend className="font-medium">Bots</legend>
        {bots.length === 0 && <p className="text-muted-foreground">No registered bots are available to invite.</p>}
        <div className="grid gap-1 sm:grid-cols-2">
          {bots.map((b) => (
            <label key={b.conversation_id} className="flex items-center gap-2 rounded-xl border px-3 py-2">
              <input type="checkbox" checked={members.includes(b.conversation_id)} onChange={() => toggle(b.conversation_id)} />
              <BotAvatar id={b.conversation_id} name={b.name} />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              <input
                type="radio"
                name="lead"
                aria-label={`${b.name} leads`}
                checked={lead === b.conversation_id}
                disabled={!members.includes(b.conversation_id)}
                onChange={() => setLead(b.conversation_id)}
              />
              <span className="text-xs text-muted-foreground">lead</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || members.length < 2}>Open huddle</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function HuddleDetail({ id, onNavigate }: { id: string; onNavigate: (hash: string) => void }) {
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'message' | 'handoff'>('message');
  const [targets, setTargets] = useState<string[]>([]);
  const [inviting, setInviting] = useState(false);
  const [candidates, setCandidates] = useState<HuddleParticipant[]>([]);
  const [actionTitle, setActionTitle] = useState('');
  const [actionOwner, setActionOwner] = useState('');
  const [closing, setClosing] = useState(false);
  const [verification, setVerification] = useState('');
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await huddlesApi.get(id);
      setHuddle(r.huddle);
      setError('');
      if (r.huddle.last_seq !== lastSeq.current) {
        lastSeq.current = r.huddle.last_seq;
        requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    lastSeq.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!huddle) return <p role="status" className="p-6 text-sm text-muted-foreground">{error || 'Opening huddle…'}</p>;
  const names = new Map(huddle.members.map((m) => [m.conversation_id, m.name]));
  const active = huddle.members.filter((m) => !m.left_at);
  const toggleTarget = (cid: string) => setTargets((t) => (t.includes(cid) ? t.filter((x) => x !== cid) : [...t, cid]));
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const mentioned = [...new Set([...targets, ...mentionTargets(text, huddle.members)])];
    const ok = await act(() => huddlesApi.post(id, { text, targets: mentioned, kind }));
    if (ok) {
      setText('');
      setTargets([]);
      setKind('message');
    }
  };
  const openInvite = () =>
    void act(async () => {
      setCandidates((await huddlesApi.candidates(id)).bots);
      setInviting(true);
    });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b bg-card px-4 py-3 sm:px-6">
        <button className="mb-2 flex min-h-8 items-center gap-2 text-sm text-muted-foreground" onClick={() => onNavigate('#/huddles')}>
          <ArrowLeft className="size-4" /> All huddles
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{huddle.goal}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{huddleStatusLabel(huddle)}</p>
            {huddle.status_note && <p className="mt-1 text-sm">Status: {huddle.status_note}</p>}
            {huddle.status === 'closed' && huddle.close_verification && (
              <p className="mt-1 text-sm text-muted-foreground">Verified by {huddle.closed_by}: {huddle.close_verification}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill huddle={huddle} />
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw className="size-4" />
            </Button>
            {huddle.status === 'open' && huddle.can_manage && (
              <Button variant="outline" onClick={() => setClosing((c) => !c)} disabled={busy}>Close as complete</Button>
            )}
            {huddle.status === 'closed' && huddle.can_post && (
              <Button variant="outline" onClick={() => setReopening((c) => !c)} disabled={busy}>Reopen</Button>
            )}
          </div>
        </div>
        {closing && (
          <form
            className="mt-3 grid gap-2 rounded-xl border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => huddlesApi.close(id, verification)).then((ok) => ok && setClosing(false));
            }}
          >
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Verification (what proves the outcome is complete)</span>
              <textarea className={field} required minLength={10} rows={2} value={verification} onChange={(e) => setVerification(e.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">Open actions are cancelled. History stays; the huddle can be reopened.</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Close huddle</Button>
              <Button type="button" variant="outline" onClick={() => setClosing(false)}>Cancel</Button>
            </div>
          </form>
        )}
        {reopening && (
          <form
            className="mt-3 grid gap-2 rounded-xl border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => huddlesApi.reopen(id, reason)).then((ok) => ok && setReopening(false));
            }}
          >
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Why reopen</span>
              <input className={field} required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Reopen</Button>
              <Button type="button" variant="outline" onClick={() => setReopening(false)}>Cancel</Button>
            </div>
          </form>
        )}
        <section aria-label="Participants" className="mt-3 flex flex-wrap items-center gap-2">
          {huddle.members.map((m) => (
            <span
              key={m.conversation_id}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm',
                m.left_at && 'opacity-50',
                huddle.owner?.conversation_id === m.conversation_id && !m.left_at && 'border-amber-500/50 bg-amber-500/5',
              )}
              title={m.left_at ? 'Left the huddle' : m.pending_wake ? 'Wake pending' : m.unread ? `${m.unread} unread` : 'Up to date'}
            >
              <span className="[&>svg]:size-6 [&>svg]:rounded-lg">
                <BotAvatar id={m.conversation_id} name={m.name} />
              </span>
              <button className="hover:underline" onClick={() => onNavigate(`#/chat/${m.conversation_id}?from=bots`)}>{m.name}</button>
              {m.role === 'lead' && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold uppercase text-primary">lead</span>}
              {huddle.owner?.conversation_id === m.conversation_id && !m.left_at && (
                <span className="rounded-full bg-amber-500/10 px-1.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">owner</span>
              )}
              {m.archived && <span className="text-[10px] text-muted-foreground">archived</span>}
              {!m.left_at && m.unread > 0 && <span aria-label={`${m.unread} unread`} className="size-2 rounded-full bg-primary" />}
              {huddle.can_manage && huddle.status === 'open' && !m.left_at && m.role !== 'lead' && (
                <button className="text-xs text-muted-foreground hover:text-destructive" aria-label={`Remove ${m.name}`} onClick={() => void act(() => huddlesApi.remove(id, m.conversation_id))}>×</button>
              )}
            </span>
          ))}
          {huddle.status === 'open' && huddle.can_post && (
            <Button variant="outline" size="sm" className="rounded-full" onClick={openInvite} disabled={busy}>
              <UserPlus className="mr-1 size-3.5" /> Invite
            </Button>
          )}
        </section>
        {inviting && (
          <div className="mt-2 flex flex-wrap gap-2 rounded-xl border p-3">
            {candidates.length === 0 && <span className="text-sm text-muted-foreground">Every eligible bot is already here.</span>}
            {candidates.map((c) => (
              <Button key={c.conversation_id} size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => huddlesApi.invite(id, [c.conversation_id])).then(() => setInviting(false))}>
                <Plus className="mr-1 size-3" /> {c.name}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>Done</Button>
          </div>
        )}
        {huddle.status === 'open' && huddle.can_post && active.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Owner:</span>
            <select
              aria-label="Current owner"
              className="rounded-lg border bg-background px-2 py-1 text-sm"
              value={huddle.owner?.conversation_id ?? ''}
              disabled={busy}
              onChange={(e) => void act(() => huddlesApi.patch(id, { owner: e.target.value || null }))}
            >
              <option value="">Nobody</option>
              {active.map((m) => (
                <option key={m.conversation_id} value={m.conversation_id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}
      </header>
      {error && <p role="alert" className="border-b border-destructive/30 px-4 py-2 text-sm text-destructive">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-h-0 flex-col">
          <ol aria-label="Huddle messages" className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {huddle.messages.map((m) => (
              <HuddleMessageRow key={m.id} message={m} names={names} />
            ))}
            <div ref={bottom} />
          </ol>
          {huddle.status === 'open' && huddle.can_post ? (
            <form onSubmit={send} className="border-t bg-card p-3 sm:px-6" aria-label="Post in huddle">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {active.map((m) => (
                  <button
                    type="button"
                    key={m.conversation_id}
                    aria-pressed={targets.includes(m.conversation_id)}
                    onClick={() => toggleTarget(m.conversation_id)}
                    className={cn('rounded-full border px-2.5 py-1 text-xs', targets.includes(m.conversation_id) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}
                  >
                    @{m.name}
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={kind === 'handoff'} disabled={targets.length !== 1} onChange={(e) => setKind(e.target.checked ? 'handoff' : 'message')} />
                  Hand off ownership
                </label>
              </div>
              <div className="flex items-end gap-2">
                <textarea
                  aria-label="Message"
                  className={cn(field, 'min-h-11 resize-y')}
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={targets.length ? `Message to ${targets.map((t) => names.get(t)).join(', ')}` : huddle.owner ? `Untargeted messages go to ${huddle.owner.name}` : 'Untargeted messages go to the lead'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
                  }}
                />
                <Button type="submit" disabled={busy || !text.trim()}>Post</Button>
              </div>
            </form>
          ) : (
            <p className="border-t px-4 py-3 text-sm text-muted-foreground">{huddle.status === 'closed' ? 'This huddle is closed. Reopen it to continue.' : 'You can watch this huddle but not post in it.'}</p>
          )}
        </div>
        <aside aria-label="Actions" className="min-h-0 overflow-y-auto border-t bg-card p-4 lg:border-l lg:border-t-0">
          <h2 className="mb-2 text-sm font-semibold">Actions</h2>
          {huddle.actions.length === 0 && <p className="text-sm text-muted-foreground">No tracked actions yet.</p>}
          <ul className="space-y-2">
            {huddle.actions.map((a) => (
              <li key={a.id} className="rounded-xl border p-2.5 text-sm">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.title}</span>
                  <ActionPill status={a.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.owner ? `Owner: ${a.owner.name}` : 'No owner'}
                  {a.blocked_by.length > 0 && a.status === 'open' && ` · waits on ${a.blocked_by.length}`}
                  {a.note && ` · ${a.note}`}
                </p>
                {huddle.status === 'open' && huddle.can_post && (a.status === 'open' || a.status === 'blocked') && (
                  <div className="mt-1.5 flex gap-1">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => huddlesApi.updateAction(id, a.id, { status: 'done' }))}>
                      <Check className="mr-1 size-3" /> Done
                    </Button>
                    {a.status === 'open' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => huddlesApi.updateAction(id, a.id, { status: 'blocked' }))}>Blocked</Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {huddle.status === 'open' && huddle.can_post && (
            <form
              className="mt-3 grid gap-2"
              aria-label="Add action"
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => huddlesApi.addAction(id, { title: actionTitle, owner: actionOwner || null })).then((ok) => {
                  if (ok) {
                    setActionTitle('');
                    setActionOwner('');
                  }
                });
              }}
            >
              <input className={field} placeholder="New action" required minLength={2} value={actionTitle} onChange={(e) => setActionTitle(e.target.value)} />
              <select className={field} aria-label="Action owner" value={actionOwner} onChange={(e) => setActionOwner(e.target.value)}>
                <option value="">No owner yet</option>
                {active.map((m) => (
                  <option key={m.conversation_id} value={m.conversation_id}>{m.name}</option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline" disabled={busy || actionTitle.trim().length < 2}>
                <Plus className="mr-1 size-3" /> Add action
              </Button>
            </form>
          )}
        </aside>
      </div>
    </div>
  );
}

export function Huddles({ huddleId, onNavigate }: { huddleId?: string; onNavigate: (hash: string) => void }) {
  const { business, select } = useBusinessSelection();
  const [teams, setTeams] = useState<BusinessTeam[]>([]);
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [huddles, setHuddles] = useState<HuddleSummary[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void huddlesApi
        .list(status, business)
        .then((r) => {
          if (active) {
            setHuddles(r.huddles);
            setError('');
          }
        })
        .catch((e: Error) => active && setError(e.message));
      void botsApi.list('all', business).then((r) => active && setTeams(r.teams ?? [])).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [status, business, huddleId]);
  return (
    <div className="flex h-full min-h-0">
      <div className="hidden w-72 shrink-0 md:block">
        <BotConversationRail selectedId={null} onNavigate={onNavigate} />
      </div>
      <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        {huddleId ? (
          <div className="min-h-0 min-w-0 flex-1">
            <HuddleDetail id={huddleId} onNavigate={onNavigate} />
          </div>
        ) : (
          <div className="mx-auto h-full min-h-0 w-full max-w-4xl overflow-y-auto overscroll-contain px-4 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-10 sm:px-6">
            <div className="mb-4 flex flex-wrap items-center gap-2 md:hidden">
              <BusinessSelector compact teams={teams} business={business} onSelect={select} />
            </div>
            <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="size-4" /> Bots working together
                </div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Huddles</h1>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  Focused group threads your bots open when one outcome needs several of them. One lead stays accountable; you can watch, join or redirect without playing router.
                </p>
              </div>
              <Button className="min-h-11" variant="outline" onClick={() => setCreating((c) => !c)}>
                <Plus className="mr-2 size-4" /> New huddle
              </Button>
            </header>
            {creating && <NewHuddleForm onCreated={(id) => { setCreating(false); onNavigate(`#/huddles/${id}`); }} onCancel={() => setCreating(false)} />}
            {error && <p role="alert" className="mb-4 rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
            <div className="mb-3 flex gap-1" role="tablist" aria-label="Huddle status">
              {(['open', 'closed'] as const).map((s) => (
                <button
                  key={s}
                  role="tab"
                  aria-selected={status === s}
                  onClick={() => setStatus(s)}
                  className={cn('rounded-full px-3 py-1.5 text-sm', status === s ? 'bg-muted font-medium' : 'text-muted-foreground')}
                >
                  {s === 'open' ? 'Open' : 'Closed'}
                </button>
              ))}
            </div>
            {huddles.length === 0 && !error && (
              <p className="rounded-2xl border p-5 text-sm text-muted-foreground">
                {status === 'open' ? 'No open huddles. Bots open one automatically when sustained work needs three or more of them.' : 'No closed huddles yet.'}
              </p>
            )}
            <ul className="divide-y rounded-2xl border bg-card empty:hidden">
              {huddles.map((h) => (
                <li key={h.id}>
                  <button className="flex w-full items-start gap-3 p-4 text-left hover:bg-muted" onClick={() => onNavigate(`#/huddles/${h.id}`)}>
                    <BotAvatar id={h.lead.conversation_id} name={h.lead.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium [overflow-wrap:anywhere]">{h.goal}</span>
                      <span className="block text-xs text-muted-foreground">
                        Lead {h.lead.name} · {h.member_count} bots · {huddleStatusLabel(h)}
                      </span>
                      {h.status_note && <span className="mt-0.5 block text-xs">{h.status_note}</span>}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill huddle={h} />
                      <time className="text-[11px] text-muted-foreground" dateTime={h.updated_at}>{when(h.last_message_at ?? h.updated_at)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
