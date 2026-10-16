import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatDecisionCard } from '@/components/chat/ChatDecisionCard';
import { CHAT_DECISIONS_CHANGED } from '@/components/chat/OpenQuestionsPanel';
import { BotAvatar } from '@/components/BotIdentity';
import { csTicketsApi, isOpenQuestion, type BotDecision, type CsTicket, type CsTicketListItem, type CsTicketMessage } from '@/lib/bots';
import { cn } from '@/lib/utils';

/**
 * Miles pilot: one bot's customer tickets worked inside Veneer. The list is the
 * bot's Tickets tab (Needs you / Waiting / Done / All); a ticket shows the whole
 * thread, its orders and notes, the open question with its choices, and a note
 * box so the human steers the bot without opening OrderOps.
 */
const FILTERS = [
  { id: 'needs_you', label: 'Needs you' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
] as const;
type Filter = (typeof FILTERS)[number]['id'];
const isFilter = (v: string | null): v is Filter => FILTERS.some((f) => f.id === v);

export function ticketStatusLabel(t: Pick<CsTicketListItem, 'status' | 'open_decision'>): string {
  if (t.open_decision) return 'Needs you';
  switch (t.status) {
    case 'waiting_human': return 'Needs you';
    case 'waiting_customer': return 'Waiting on customer';
    case 'done': return 'Done';
    default: return 'Bot is working';
  }
}
export function ticketHref(botId: string, ticketId?: string): string {
  return `#/bots/tickets/${encodeURIComponent(botId)}${ticketId ? `/${encodeURIComponent(ticketId)}` : ''}`;
}
const ago = (iso: string | null) => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(m, 0)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : iso;
};

export function BotTickets({ botId, ticketId, onNavigate }: { botId: string; ticketId?: string; onNavigate: (hash: string) => void }) {
  const [filter, setFilter] = useState<Filter>(() => {
    const requested = typeof window === 'undefined' ? null : new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('filter');
    return isFilter(requested) ? requested : 'all';
  });
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ owner: { conversation_id: string; name: string }; enabled: boolean; tickets: CsTicketListItem[] } | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const next = await csTicketsApi.list(botId, filter, q, controller.signal);
      if (!controller.signal.aborted) { setData(next); setError(''); }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    }
  }, [botId, filter, q]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    const onChange = () => void refresh();
    window.addEventListener(CHAT_DECISIONS_CHANGED, onChange);
    return () => { clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, onChange); abort.current?.abort(); };
  }, [refresh]);
  const counts = useMemo(() => ({ needs_you: data?.tickets.filter((t) => ticketStatusLabel(t) === 'Needs you').length ?? 0 }), [data]);
  const list = (
    <section aria-label="Tickets" className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 p-4 pb-2">
        <button className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground" onClick={() => onNavigate('#/bots')}><ArrowLeft className="size-4" /> Bots</button>
      </header>
      <div className="flex items-center gap-3 px-4">
        <BotAvatar id={botId} name={data?.owner.name ?? 'Bot'} />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">{data?.owner.name ?? 'Bot'} · Tickets</h1>
          <p className="text-xs text-muted-foreground">{data && !data.enabled ? 'Not enrolled to own tickets inside Veneer.' : filter === 'all' && counts.needs_you ? `${counts.needs_you} need${counts.needs_you === 1 ? 's' : ''} you` : 'Tickets this bot owns start to finish inside Veneer.'}</p>
        </div>
      </div>
      <nav aria-label="Ticket filters" className="flex gap-1 overflow-x-auto px-4 pt-3">
        {FILTERS.map((f) => <Button key={f.id} size="sm" variant={filter === f.id ? 'secondary' : 'ghost'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</Button>)}
      </nav>
      <label className="mx-4 mt-3 flex min-h-11 items-center gap-2 rounded-xl border bg-background px-3 text-sm">
        <Search className="size-4 text-muted-foreground" />
        <input aria-label="Search tickets" className="min-w-0 flex-1 bg-transparent outline-none" placeholder="Search tickets" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {error && <p role="alert" className="px-4 pt-3 text-sm text-destructive">{error}</p>}
      <ul className="mt-3 min-h-0 flex-1 divide-y overflow-y-auto border-t">
        {data && data.tickets.length === 0 && <li className="p-4 text-sm text-muted-foreground">No tickets in this view.</li>}
        {data?.tickets.map((t) => {
          const needsYou = ticketStatusLabel(t) === 'Needs you';
          return <li key={t.id}>
            <button data-ticket-id={t.id} aria-current={t.id === ticketId ? 'true' : undefined} onClick={() => onNavigate(ticketHref(botId, t.id))}
              className={cn('grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-4 text-left hover:bg-muted/50', t.id === ticketId && 'bg-muted')}>
              <span aria-label={ticketStatusLabel(t)} className={cn('mt-1.5 size-2.5 rounded-full', needsYou ? 'bg-amber-500' : t.status === 'done' ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              <span className="min-w-0">
                <span className="block truncate font-medium">{t.open_decision?.question || t.subject || `Ticket ${t.orderops_ticket_id}`}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.orderops_ticket_id} · {t.customer_name || t.customer_email || 'Customer'}{t.open_decision?.recommended ? ` · Pick: ${t.open_decision.recommended}` : ` · ${ticketStatusLabel(t)}`}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">{ago(t.updated_at)}</span>
            </button>
          </li>;
        })}
      </ul>
    </section>
  );
  return (
    <div className="flex h-full min-h-0">
      <div className={cn('min-h-0 min-w-0 flex-1 md:max-w-md md:border-r', ticketId && 'hidden md:flex md:flex-col')}>{list}</div>
      {ticketId ? <TicketDetail key={ticketId} botId={botId} ticketId={ticketId} onNavigate={onNavigate} onChanged={() => void refresh()} />
        : <div className="hidden min-w-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">Choose a ticket to read the whole thread and answer in place.</div>}
    </div>
  );
}

function TicketDetail({ botId, ticketId, onNavigate, onChanged }: { botId: string; ticketId: string; onNavigate: (hash: string) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<{ ticket: CsTicket; owner: { conversation_id: string; name: string }; messages: CsTicketMessage[]; decisions: BotDecision[] } | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [remember, setRemember] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const noteKey = useRef(crypto.randomUUID());
  const load = useCallback(async () => {
    try { setDetail(await csTicketsApi.detail(ticketId)); setError(''); } catch (e) { setError((e as Error).message); }
  }, [ticketId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    const onChange = () => void load();
    window.addEventListener(CHAT_DECISIONS_CHANGED, onChange);
    return () => { clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, onChange); };
  }, [load]);
  const send = async () => {
    const body = note.trim();
    if (!body || sending) return;
    setSending(true);
    setError('');
    try {
      await csTicketsApi.note(ticketId, { body, remember, request_key: noteKey.current });
      noteKey.current = crypto.randomUUID();
      setNote('');
      setRemember(false);
      setSent(remember ? 'Sent. The bot will apply it here and remember it.' : 'Sent to the bot.');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const t = detail?.ticket;
  const open = detail?.decisions.filter(isOpenQuestion) ?? [];
  const answered = detail?.decisions.filter((d) => !isOpenQuestion(d)) ?? [];
  return (
    <section aria-label="Ticket" className="conversation-surface flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-card [overflow-wrap:anywhere]">
      <header className="flex items-center justify-between gap-3 p-4 pb-2">
        <button className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground" onClick={() => onNavigate(ticketHref(botId))}><ArrowLeft className="size-4" /> Tickets</button>
        {t?.ticket_conversation_id && <a className="text-sm underline" href={`#/chat/${encodeURIComponent(t.ticket_conversation_id)}?from=bots`}>Open chat</a>}
      </header>
      {error && <p role="alert" className="px-4 text-sm text-destructive">{error}</p>}
      {!t ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading ticket…</p> : <div className="space-y-5 px-4 pb-8">
        <div>
          <p className="text-xs text-muted-foreground">{t.orderops_ticket_id} · {t.channel} · {ticketStatusLabel({ status: t.status, open_decision: open[0] ? { id: open[0].id, version: open[0].version, question: '', recommended: null } : null })} · updated {ago(t.updated_at)} ago</p>
          <h2 className="text-xl font-semibold leading-snug">{t.subject || `Ticket ${t.orderops_ticket_id}`}</h2>
          <p className="text-sm text-muted-foreground">{t.customer_name || 'Customer'}{t.customer_email ? ` · ${t.customer_email}` : ''}{t.customer_phone ? ` · ${t.customer_phone}` : ''}</p>
          {t.orders.length > 0 && <p className="text-sm">Orders: {t.orders.map((o) => o.order_number).join(', ')}</p>}
          {t.summary && <p className="mt-1 text-sm">{t.summary}</p>}
          <p className="mt-1 text-xs text-muted-foreground">{t.last_polled_at ? `Checked OrderOps ${ago(t.last_polled_at)} ago` : 'OrderOps not checked yet'}{t.last_poll_error ? ` · last check failed: ${t.last_poll_error}` : ''}</p>
        </div>
        {open.map((d) => <ChatDecisionCard key={`${d.id}:${d.version}`} decision={d} />)}
        <details open className="rounded-xl border">
          <summary className="cursor-pointer p-3 text-sm font-medium">Thread · {detail!.messages.length}</summary>
          <ol className="divide-y">
            {detail!.messages.map((m) => <li key={m.id} className={cn('p-3 text-sm', m.direction === 'note' && 'bg-muted/40')}>
              <p className="text-xs text-muted-foreground">
                {m.direction === 'in' ? 'From' : m.direction === 'out' ? 'Sent by' : 'Note from'} {m.author_label || m.author} · {when(m.at)}{m.channel ? ` · ${m.channel}` : ''}{m.remember ? ' · Remembered' : ''}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              {m.attachments.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Attachments: {m.attachments.map((a) => a.name).join(', ')}</p>}
            </li>)}
          </ol>
        </details>
        {answered.length > 0 && <details className="rounded-xl border">
          <summary className="cursor-pointer p-3 text-sm font-medium">Earlier questions · {answered.length}</summary>
          <div className="space-y-3 p-3">{answered.map((d) => <ChatDecisionCard key={`${d.id}:${d.version}`} decision={d} />)}</div>
        </details>}
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="block text-sm font-medium">Add a note for {detail!.owner.name}
            <textarea className="mt-1 block w-full rounded-lg border bg-background p-2 text-sm" rows={3} value={note} placeholder="Tell the bot what to do on this ticket" onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
          </label>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" disabled={sending || !note.trim()}>Send</Button>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember</label>
            {sent && <span role="status" className="text-sm text-muted-foreground">{sent}</span>}
          </div>
        </form>
      </div>}
    </section>
  );
}
