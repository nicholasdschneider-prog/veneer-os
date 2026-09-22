import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Info, ListChecks, Lock, Plus, Send, Users, UserPlus, X } from 'lucide-react';
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
  type HuddleMember,
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
  if (system)
    return (
      <li data-kind="system" className="mx-auto max-w-[36rem] whitespace-pre-wrap rounded-xl bg-muted/60 px-3 py-1.5 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]" title={clock(message.created_at)}>
        {message.body}
      </li>
    );
  const person = message.author.user_id !== null;
  return (
    <li data-kind={message.kind} className="flex gap-2.5">
      <span className="mt-4 shrink-0 [&>svg]:size-8 [&>svg]:rounded-lg">
        {authorId ? (
          <BotAvatar id={authorId} name={message.author.name} />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">{message.author.name.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <div className="min-w-0 max-w-[85%]">
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 text-xs">
          <span className="font-medium text-foreground">{message.author.name}</span>
          {person && <span className="text-muted-foreground">person</span>}
          {message.kind === 'handoff' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <ArrowRight className="size-3" /> handoff{targets.length ? ` to ${targets.join(', ')}` : ''}
            </span>
          )}
          {message.kind === 'status' && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">status</span>}
          {message.kind === 'message' && targets.length > 0 && <span className="text-muted-foreground">to {targets.join(', ')}</span>}
          <time dateTime={message.created_at} className="text-[11px] text-muted-foreground" title={`#${message.seq} · ${clock(message.created_at)}`}>{when(message.created_at)}</time>
        </div>
        <div className={cn('rounded-2xl rounded-tl-md px-3.5 py-2 text-sm [overflow-wrap:anywhere]', person ? 'bg-primary/10' : 'bg-card border')}>
          <Markdown markdown={message.body} />
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

function avatarStack(members: HuddleMember[]) {
  const active = members.filter((m) => !m.left_at).slice(0, 4);
  return (
    <span className="flex -space-x-2 [&>svg]:size-6 [&>svg]:rounded-md [&>svg]:ring-2 [&>svg]:ring-background" aria-hidden="true">
      {active.map((m) => (
        <BotAvatar key={m.conversation_id} id={m.conversation_id} name={m.name} />
      ))}
    </span>
  );
}

function DetailsPanel({ huddle, busy, act, onNavigate, id }: { huddle: Huddle; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; onNavigate: (hash: string) => void; id: string }) {
  const [inviting, setInviting] = useState(false);
  const [candidates, setCandidates] = useState<HuddleParticipant[]>([]);
  const [closing, setClosing] = useState(false);
  const [verification, setVerification] = useState('');
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const active = huddle.members.filter((m) => !m.left_at);
  const openInvite = () =>
    void act(async () => {
      setCandidates((await huddlesApi.candidates(id)).bots);
      setInviting(true);
    });
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goal</h3>
        <p className="font-medium [overflow-wrap:anywhere]">{huddle.goal}</p>
        {huddle.why && <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">{huddle.why}</p>}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill huddle={huddle} />
          <span className="text-muted-foreground">{huddleStatusLabel(huddle)}</span>
        </div>
        {huddle.status_note && <p className="mt-2 [overflow-wrap:anywhere]">{huddle.status_note}</p>}
        {huddle.status === 'closed' && huddle.close_verification && (
          <p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">Verified by {huddle.closed_by}: {huddle.close_verification}</p>
        )}
        {huddle.status === 'open' && huddle.can_post && active.length > 1 && (
          <label className="mt-3 flex items-center gap-2">
            <span className="text-muted-foreground">Owner</span>
            <select
              aria-label="Current owner"
              className="rounded-lg border bg-background px-2 py-1"
              value={huddle.owner?.conversation_id ?? ''}
              disabled={busy}
              onChange={(e) => void act(() => huddlesApi.patch(id, { owner: e.target.value || null }))}
            >
              <option value="">Nobody</option>
              {active.map((m) => (
                <option key={m.conversation_id} value={m.conversation_id}>{m.name}</option>
              ))}
            </select>
          </label>
        )}
      </section>
      <section aria-label="Participants">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Participants · {active.length}</h3>
        <ul className="space-y-1.5">
          {huddle.members.map((m) => (
            <li key={m.conversation_id} className={cn('flex items-center gap-2 rounded-xl border px-2 py-1.5', m.left_at && 'opacity-50', huddle.owner?.conversation_id === m.conversation_id && !m.left_at && 'border-amber-500/50 bg-amber-500/5')}>
              <span className="[&>svg]:size-7 [&>svg]:rounded-lg"><BotAvatar id={m.conversation_id} name={m.name} /></span>
              <button className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => onNavigate(`#/chat/${m.conversation_id}?from=bots`)}>{m.name}</button>
              {m.role === 'lead' && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold uppercase text-primary">lead</span>}
              {huddle.owner?.conversation_id === m.conversation_id && !m.left_at && <span className="rounded-full bg-amber-500/10 px-1.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">owner</span>}
              {m.left_at ? <span className="text-[10px] text-muted-foreground">left</span> : m.archived ? <span className="text-[10px] text-muted-foreground">archived</span> : m.pending_wake ? <span className="text-[10px] text-muted-foreground">waking</span> : m.unread > 0 ? <span aria-label={`${m.unread} unread`} className="size-2 rounded-full bg-primary" /> : null}
              {huddle.can_manage && huddle.status === 'open' && !m.left_at && m.role !== 'lead' && (
                <button className="px-1 text-muted-foreground hover:text-destructive" aria-label={`Remove ${m.name}`} onClick={() => void act(() => huddlesApi.remove(id, m.conversation_id))}>×</button>
              )}
            </li>
          ))}
        </ul>
        {huddle.status === 'open' && huddle.can_post && (
          <div className="mt-2">
            {inviting ? (
              <div className="flex flex-wrap gap-1.5 rounded-xl border p-2">
                {candidates.length === 0 && <span className="text-muted-foreground">Every eligible bot is already here.</span>}
                {candidates.map((c) => (
                  <Button key={c.conversation_id} size="sm" variant="secondary" disabled={busy} onClick={() => void act(() => huddlesApi.invite(id, [c.conversation_id])).then(() => setInviting(false))}>
                    <Plus className="mr-1 size-3" /> {c.name}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>Done</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={openInvite} disabled={busy}><UserPlus className="mr-1 size-3.5" /> Invite a bot</Button>
            )}
          </div>
        )}
      </section>
      <section>
        {huddle.status === 'open' && huddle.can_manage && !closing && (
          <Button variant="outline" onClick={() => setClosing(true)} disabled={busy}><Check className="mr-1 size-4" /> Close as complete</Button>
        )}
        {closing && (
          <form className="grid gap-2 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); void act(() => huddlesApi.close(id, verification)).then((ok) => ok && setClosing(false)); }}>
            <label className="grid gap-1">
              <span className="font-medium">What proves the outcome is complete?</span>
              <textarea className={field} required minLength={10} rows={2} value={verification} onChange={(e) => setVerification(e.target.value)} />
            </label>
            <p className="text-xs text-muted-foreground">Open actions are cancelled. History stays; the huddle can be reopened.</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Close huddle</Button>
              <Button type="button" variant="outline" onClick={() => setClosing(false)}>Cancel</Button>
            </div>
          </form>
        )}
        {huddle.status === 'closed' && huddle.can_post && !reopening && (
          <Button variant="outline" onClick={() => setReopening(true)} disabled={busy}>Reopen</Button>
        )}
        {reopening && (
          <form className="grid gap-2 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); void act(() => huddlesApi.reopen(id, reason)).then((ok) => ok && setReopening(false)); }}>
            <label className="grid gap-1">
              <span className="font-medium">Why reopen</span>
              <input className={field} required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>Reopen</Button>
              <Button type="button" variant="outline" onClick={() => setReopening(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function ActionsPanel({ huddle, busy, act, id }: { huddle: Huddle; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<boolean>; id: string }) {
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [adding, setAdding] = useState(false);
  const active = huddle.members.filter((m) => !m.left_at);
  const editable = huddle.status === 'open' && huddle.can_post;
  return (
    <div className="text-sm">
      {huddle.actions.length === 0 && <p className="text-muted-foreground">No tracked actions yet.</p>}
      <ul className="space-y-2">
        {huddle.actions.map((a) => (
          <li key={a.id} className="rounded-xl border p-2.5">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.title}</span>
              <ActionPill status={a.status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {a.owner ? `Owner: ${a.owner.name}` : 'No owner'}
              {a.blocked_by.length > 0 && a.status === 'open' && ` · waits on ${a.blocked_by.length}`}
              {a.note && ` · ${a.note}`}
            </p>
            {editable && (a.status === 'open' || a.status === 'blocked') && (
              <div className="mt-1.5 flex gap-1">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => huddlesApi.updateAction(id, a.id, { status: 'done' }))}><Check className="mr-1 size-3" /> Done</Button>
                {a.status === 'open' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => huddlesApi.updateAction(id, a.id, { status: 'blocked' }))}>Blocked</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {editable && (adding ? (
        <form className="mt-3 grid gap-2" aria-label="Add action" onSubmit={(e) => { e.preventDefault(); void act(() => huddlesApi.addAction(id, { title, owner: owner || null })).then((ok) => { if (ok) { setTitle(''); setOwner(''); setAdding(false); } }); }}>
          <input className={field} placeholder="New action" required minLength={2} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className={field} aria-label="Action owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">No owner yet</option>
            {active.map((m) => <option key={m.conversation_id} value={m.conversation_id}>{m.name}</option>)}
          </select>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || title.trim().length < 2}>Add</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button className="mt-3" size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 size-3" /> Add action</Button>
      ))}
    </div>
  );
}

/** Slide-up sheet on phones, side column on wide screens. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/40 lg:hidden" onClick={onClose} role="presentation">
      <div role="dialog" aria-label={title} className="max-h-[85%] overflow-y-auto overscroll-contain rounded-t-2xl bg-card p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}><X className="size-4" /></Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The composer: one input, inline @mention autocomplete, hand-off toggle when exactly one member is mentioned. */
export function HuddleComposer({ huddle, busy, onSend }: { huddle: Huddle; busy: boolean; onSend: (body: { text: string; targets: string[]; kind: 'message' | 'handoff' }) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [handoff, setHandoff] = useState(false);
  const [menu, setMenu] = useState<{ query: string; start: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const active = huddle.members.filter((m) => !m.left_at);
  const mentions = mentionTargets(text, huddle.members);
  const names = new Map(huddle.members.map((m) => [m.conversation_id, m.name]));
  const suggestions = menu ? active.filter((m) => m.name.toLowerCase().startsWith(menu.query.toLowerCase())) : [];
  const update = (value: string, caret: number) => {
    setText(value);
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]!)) && !/\s/.test(before.slice(at + 1))) setMenu({ query: before.slice(at + 1), start: at });
    else setMenu(null);
  };
  const pick = (name: string) => {
    if (!menu) return;
    const caret = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, menu.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = menu.start + name.length + 2;
      input.current?.focus();
      input.current?.setSelectionRange(pos, pos);
    });
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    const ok = await onSend({ text, targets: mentions, kind: handoff && mentions.length === 1 ? 'handoff' : 'message' });
    if (ok) { setText(''); setHandoff(false); setMenu(null); }
  };
  const destination = mentions.length ? mentions.map((t) => names.get(t)).join(', ') : huddle.owner?.name ?? huddle.lead.name;
  return (
    <form
      aria-label="Post in huddle"
      className="relative border-t bg-card px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:px-4"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      {menu && suggestions.length > 0 && (
        <ul role="listbox" aria-label="Mention a bot" className="absolute bottom-full left-3 mb-1 w-56 overflow-hidden rounded-xl border bg-popover shadow-lg">
          {suggestions.map((m) => (
            <li key={m.conversation_id}>
              <button type="button" role="option" aria-selected={false} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onMouseDown={(e) => { e.preventDefault(); pick(m.name); }}>
                <span className="[&>svg]:size-6 [&>svg]:rounded-md"><BotAvatar id={m.conversation_id} name={m.name} /></span>
                <span className="flex-1 truncate">{m.name}</span>
                {m.role === 'lead' && <span className="text-[10px] uppercase text-muted-foreground">lead</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mb-1.5 flex min-h-5 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {mentions.length ? (
          <>
            <span>To</span>
            {mentions.map((t) => <span key={t} className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">@{names.get(t)}</span>)}
          </>
        ) : (
          <span>Goes to {destination}. Type @ to mention someone.</span>
        )}
        {mentions.length === 1 && mentions[0] !== huddle.owner?.conversation_id && (
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={handoff} onChange={(e) => setHandoff(e.target.checked)} />
            Hand off to {names.get(mentions[0]!)}
          </label>
        )}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={input}
          aria-label="Message"
          className={cn(field, 'max-h-40 min-h-11 resize-none')}
          rows={1}
          value={text}
          onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && menu) { setMenu(null); return; }
            if (e.key === 'Enter' && menu && suggestions[0]) { e.preventDefault(); pick(suggestions[0].name); return; }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
          }}
          onInput={(e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }}
          placeholder="Message the huddle"
        />
        <Button type="submit" size="icon-lg" aria-label="Post" disabled={busy || !text.trim()}><Send className="size-4" /></Button>
      </div>
    </form>
  );
}

function HuddleDetail({ id, onNavigate }: { id: string; onNavigate: (hash: string) => void }) {
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'details' | 'actions' | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await huddlesApi.get(id);
      setHuddle(r.huddle);
      setError('');
      if (r.huddle.last_seq !== lastSeq.current) {
        lastSeq.current = r.huddle.last_seq;
        // Markdown finishes laying out after the first frame, so pin the
        // bottom twice: once now and once after the bubbles have their height.
        const toBottom = () => { if (list.current) list.current.scrollTop = list.current.scrollHeight; };
        requestAnimationFrame(toBottom);
        setTimeout(toBottom, 250);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    lastSeq.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [refresh]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); await refresh(); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }, [refresh]);
  const closePanel = useCallback(() => setPanel(null), []);
  if (!huddle) return <p role="status" className="p-6 text-sm text-muted-foreground">{error || 'Opening huddle…'}</p>;
  const names = new Map(huddle.members.map((m) => [m.conversation_id, m.name]));
  const openActions = huddle.actions.filter((a) => a.status === 'open' || a.status === 'blocked').length;
  const activeCount = huddle.members.filter((m) => !m.left_at).length;
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b bg-card px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-3">
        <Button variant="ghost" size="icon" aria-label="All huddles" onClick={() => onNavigate('#/huddles')}><ArrowLeft className="size-5" /></Button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-1 text-left hover:bg-muted" onClick={() => setPanel('details')} aria-label="Huddle details">
          {avatarStack(huddle.members)}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{huddle.goal}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {huddle.status === 'closed' ? 'Closed' : huddle.owner ? `${huddle.owner.name} has the ball` : 'No owner yet'} · {activeCount} bots{huddle.status_note ? ` · ${huddle.status_note}` : ''}
            </span>
          </span>
        </button>
        <Button variant="ghost" size="sm" className="lg:hidden" aria-label={`Actions, ${openActions} open`} onClick={() => setPanel('actions')}>
          <ListChecks className="size-4" />{openActions > 0 && <span className="ml-1 tabular-nums">{openActions}</span>}
        </Button>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Details" onClick={() => setPanel('details')}><Info className="size-5" /></Button>
      </header>
      {error && <p role="alert" className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ol ref={list} aria-label="Huddle messages" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-5">
            {huddle.messages.map((m) => <HuddleMessageRow key={m.id} message={m} names={names} />)}
          </ol>
          {huddle.status === 'open' && huddle.can_post ? (
            <HuddleComposer huddle={huddle} busy={busy} onSend={(body) => act(() => huddlesApi.post(id, body))} />
          ) : (
            <p className="border-t bg-card px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] text-sm text-muted-foreground">
              {huddle.status === 'closed' ? 'This huddle is closed. ' : 'You can watch this huddle but not post in it.'}
              {huddle.status === 'closed' && huddle.can_post && <button className="underline" onClick={() => setPanel('details')}>Reopen it</button>}
            </p>
          )}
        </div>
        <aside className="hidden w-80 shrink-0 overflow-y-auto overscroll-contain border-l bg-card p-4 lg:block" aria-label="Huddle details and actions">
          <DetailsPanel huddle={huddle} busy={busy} act={act} onNavigate={onNavigate} id={id} />
          <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions · {openActions} open</h3>
          <ActionsPanel huddle={huddle} busy={busy} act={act} id={id} />
        </aside>
      </div>
      {panel === 'details' && (
        <Sheet title="Huddle" onClose={closePanel}><DetailsPanel huddle={huddle} busy={busy} act={act} onNavigate={onNavigate} id={id} /></Sheet>
      )}
      {panel === 'actions' && (
        <Sheet title={`Actions · ${openActions} open`} onClose={closePanel}><ActionsPanel huddle={huddle} busy={busy} act={act} id={id} /></Sheet>
      )}
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
                  <button className="flex w-full items-center gap-3 p-3.5 text-left hover:bg-muted" onClick={() => onNavigate(`#/huddles/${h.id}`)}>
                    <BotAvatar id={h.lead.conversation_id} name={h.lead.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{h.goal}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {h.status === 'closed' ? 'Closed' : h.owner ? `${h.owner.name} has the ball` : 'No owner yet'} · {h.member_count} bots · lead {h.lead.name}
                        {h.status_note ? ` · ${h.status_note}` : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <time className="text-[11px] text-muted-foreground" dateTime={h.updated_at}>{when(h.last_message_at ?? h.updated_at)}</time>
                      {h.open_action_count > 0 && h.status === 'open' && <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary tabular-nums">{h.open_action_count}</span>}
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
