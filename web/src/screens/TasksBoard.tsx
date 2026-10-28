import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BotComposer } from '@/components/BotComposer';
import { ChatDecisionCard } from '@/components/chat/ChatDecisionCard';
import { ChatTasksToggle } from '@/components/chat/ChatTasksToggle';
import { CoordinationTurn, coordinationItems, type CoordinationView } from '@/components/chat/Coordination';
import { CHAT_DECISIONS_CHANGED } from '@/components/chat/OpenQuestionsPanel';
import { api } from '@/lib/api';
import { botsApi, type BotDecision } from '@/lib/bots';
import { splitAttachmentFooter } from '@/lib/botComposer';
import { BOARD_GROUPS, cleanTaskTitle, customerThreadPreferred, interleaveDiscussion, rememberCustomerThread, taskPaneHash, tasksApi, type Board, type BoardGroup, type BoardRow, type BotTask, type CustomerThread as CustomerThreadData, type TaskEvent } from '@/lib/tasks';
import { cn } from '@/lib/utils';

/**
 * The TASKS view of a bot chat (shared Tasks capability): everything in flight
 * for this bot in one list, grouped by what the human has to do next. A task
 * opens in a pane inside the board: its status, its open question card, the
 * task chat's transcript interleaved with the human's notes, and a composer
 * that speaks to that task only. Status comes from source state, so coming
 * back hours later shows the truth, not the last chat claim.
 */
const ago = (iso: string | null | undefined) => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(m, 0)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};
export function groupRows(rows: BoardRow[], showCompleted: boolean): { id: BoardGroup; label: string; rows: BoardRow[] }[] {
  return BOARD_GROUPS.filter((g) => showCompleted ? g.id === 'completed' : g.id !== 'completed').map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.id) })).filter((g) => showCompleted || g.rows.length > 0);
}
const dotColor: Record<BoardGroup, string> = { ready_for_review: 'bg-emerald-500', needs_input: 'bg-amber-500', working: 'bg-sky-500', up_next: 'bg-muted-foreground/40', completed: 'bg-muted-foreground/30' };

export function TasksBoard({ conversationId, taskId = null, onNavigate }: { conversationId: string; taskId?: string | null; onNavigate: (hash: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try { const next = await tasksApi.board(conversationId, controller.signal); if (!controller.signal.aborted) { setBoard(next); setError(''); } }
    catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
  }, [conversationId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 20000);
    const onChange = () => void refresh();
    window.addEventListener(CHAT_DECISIONS_CHANGED, onChange);
    return () => { clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, onChange); abort.current?.abort(); };
  }, [refresh]);
  const groups = useMemo(() => groupRows(board?.rows ?? [], showCompleted), [board, showCompleted]);
  const mark = async (row: BoardRow, markKind: 'done' | 'reviewed') => {
    if (row.kind !== 'task' && row.kind !== 'thread' && row.kind !== 'handoff') return;
    try { await tasksApi.mark(conversationId, { kind: row.kind, id: row.id, mark: markKind }); await refresh(); } catch (e) { setError((e as Error).message); }
  };
  const open = (row: BoardRow) => onNavigate(row.kind === 'task' ? taskPaneHash(conversationId, row.id) : row.href);
  const list = (
    <section aria-label="Tasks" className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain">
      <header className="flex items-center justify-between gap-3 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate font-medium">{board?.chat.bot_name || board?.chat.title || 'Tasks'}</h1>
          <p className="truncate text-xs text-muted-foreground">{board ? (board.needs_you ? `${board.needs_you} need${board.needs_you === 1 ? 's' : ''} you` : 'Nothing is waiting on you') : 'Loading…'}</p>
        </div>
        <ChatTasksToggle conversationId={conversationId} view="tasks" onNavigate={onNavigate} />
      </header>
      <nav aria-label="Board filter" className="flex gap-1 px-3 pt-2">
        <Button size="sm" variant={showCompleted ? 'ghost' : 'secondary'} aria-pressed={!showCompleted} onClick={() => setShowCompleted(false)}>Active</Button>
        <Button size="sm" variant={showCompleted ? 'secondary' : 'ghost'} aria-pressed={showCompleted} onClick={() => setShowCompleted(true)}>Completed{board?.counts.completed ? ` · ${board.counts.completed}` : ''}</Button>
      </nav>
      {error && <p role="alert" className="px-3 pt-2 text-sm text-destructive">{error}</p>}
      {board && !board.chat.registered && <p className="px-3 pt-2 text-sm text-muted-foreground">This chat is not a registered bot, so it only lists questions, threads and handed-off chats.</p>}
      {board && groups.every((g) => g.rows.length === 0) && <p className="p-4 text-sm text-muted-foreground">{showCompleted ? 'Nothing completed yet.' : 'Nothing in flight. Write several asks in one message in Chat and the bot turns them into tasks.'}</p>}
      {groups.map((g) => <section key={g.id} aria-label={g.label} className="px-3 pt-3">
        <h2 className="flex items-baseline gap-2 text-sm font-medium"><span>{g.label}</span><span className="text-xs text-muted-foreground">{g.rows.length}</span></h2>
        <ul className="mt-1 divide-y rounded-xl border">
          {g.rows.map((row) => <li key={`${row.kind}:${row.id}`} data-row-kind={row.kind} aria-current={row.kind === 'task' && row.id === taskId ? 'true' : undefined} className={cn(row.kind === 'task' && row.id === taskId && 'bg-muted')}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-3">
              {row.can_mark ? <input type="checkbox" aria-label={`Mark ${row.title} done`} className="mt-1 size-4" checked={false} onChange={() => void mark(row, 'done')} />
                : <span aria-hidden="true" className={cn('mt-1.5 size-2.5 rounded-full', dotColor[row.group])} />}
              <button className="min-w-0 text-left" onClick={() => open(row)}>
                <span className="block font-medium leading-snug">{row.task ? cleanTaskTitle(row.title, row.task.case_key) : row.title}</span>
                <span className="block truncate text-xs text-muted-foreground"><span className={cn(row.group === 'needs_input' && 'text-amber-700 dark:text-amber-300', row.group === 'ready_for_review' && 'text-emerald-700 dark:text-emerald-300')}>{row.status_line}</span></span>
                <span className="block text-xs text-muted-foreground">{row.tag}</span>
              </button>
              <span className="text-xs text-muted-foreground">{ago(row.updated_at)}</span>
            </div>
          </li>)}
        </ul>
      </section>)}
      <div className="h-6" />
    </section>
  );
  return (
    <div className="flex h-full min-h-0 bg-card">
      <div className={cn('min-h-0 min-w-0 flex-1 md:max-w-sm md:border-r', taskId && 'hidden md:block')}>{list}</div>
      {taskId ? <TaskPane key={taskId} conversationId={conversationId} taskId={taskId} onNavigate={onNavigate} onChanged={refresh} />
        : <div className="hidden min-w-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground md:flex">Open a task to read the bot's work on it and write to it there.</div>}
    </div>
  );
}

/** One task, in place: its status, its open question, its conversation, and a composer that speaks to it alone. */
export function TaskPane({ conversationId, taskId, onNavigate, onChanged }: { conversationId: string; taskId: string; onNavigate: (hash: string) => void; onChanged: () => Promise<void> }) {
  const [detail, setDetail] = useState<{ task: BotTask; events: TaskEvent[]; bot_name: string } | null>(null);
  const [decision, setDecision] = useState<BotDecision | null>(null);
  const [view, setView] = useState<CoordinationView | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [more, setMore] = useState(false);
  const key = useRef(crypto.randomUUID());
  const load = useCallback(async () => {
    try {
      const d = await tasksApi.task(conversationId, taskId);
      setDetail(d);
      setError('');
      if (d.task.open_decision) {
        const list = await botsApi.decisionsFor(conversationId).catch(() => ({ decisions: [] as BotDecision[] }));
        setDecision(list.decisions.find((x) => x.id === d.task.open_decision!.id) ?? null);
      } else setDecision(null);
      if (d.task.thread_id) setView(await api.coordinationThread(d.task.thread_id).catch(() => null));
    } catch (e) { setError((e as Error).message); }
  }, [conversationId, taskId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    const onChange = () => void load();
    window.addEventListener(CHAT_DECISIONS_CHANGED, onChange);
    return () => { clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, onChange); };
  }, [load]);
  const close = () => onNavigate(taskPaneHash(conversationId, null));
  const send = async (text: string) => {
    const { body, paths } = splitAttachmentFooter(text);
    if ((!body && !paths.length) || sending) return;
    setSending(true);
    try {
      await tasksApi.discuss(conversationId, taskId, { text: body || `Sent ${paths.length} file${paths.length === 1 ? '' : 's'}.`, request_key: key.current, ...(paths.length ? { attachments: paths.map((p) => ({ name: p.split('/').pop() || p, reference: p })) } : {}) });
      key.current = crypto.randomUUID();
      setNote('Sent to the bot for this task.');
      await load();
      await onChanged();
    } catch (e) { setNote((e as Error).message); }
    finally { setSending(false); }
  };
  const t = detail?.task;
  const bot = detail?.bot_name || 'The bot';
  const turns = view ? coordinationItems(view) : [];
  const stream = interleaveDiscussion(turns, detail?.events ?? []);
  const brief = t?.brief.trim() ?? '';
  const short = brief.length > 280 ? `${brief.slice(0, 280).trimEnd()}…` : brief;
  const files = (detail?.events ?? []).flatMap((e) => (Array.isArray(e.payload.attachments) ? (e.payload.attachments as { name: string; reference?: string }[]) : []));
  return (
    <section aria-label="Task" className="conversation-surface flex h-full min-h-0 min-w-0 flex-1 flex-col bg-card [overflow-wrap:anywhere]">
      <header className="flex items-start gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Back to tasks" onClick={close}><ArrowLeft className="size-4" /></Button>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium leading-snug">{t ? cleanTaskTitle(t.title, t.case_key) : 'Task'}</h2>
          <p className={cn('text-xs', t?.status === 'needs_input' ? 'text-amber-700 dark:text-amber-300' : t?.status === 'ready_for_review' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>{t?.status_line || (detail ? 'No status yet' : 'Loading…')}{t?.case_key ? ` · case ${t.case_key}` : ''}</p>
        </div>
        {t && t.status !== 'done' && <Button size="sm" variant="outline" onClick={async () => { await tasksApi.mark(conversationId, { kind: 'task', id: taskId, mark: 'done' }); await load(); await onChanged(); }}>Mark it done</Button>}
        <Button variant="ghost" size="icon" className="hidden md:inline-flex" aria-label="Close task" onClick={close}><X className="size-4" /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3 text-sm">
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {decision && <ChatDecisionCard key={`${decision.id}:${decision.version}`} decision={decision} />}
        {t && <CustomerThreadSection conversationId={conversationId} taskId={taskId} caseKey={t.case_key} bot={bot} />}
        <section aria-label={`Conversation with ${bot} on this task`} className="space-y-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversation with {bot} on this task</h3>
          {detail && stream.length === 0 && <p className="text-muted-foreground">{bot} hasn't started on this yet.{t?.status_line ? ` ${/[.?!]$/.test(t.status_line) ? t.status_line : `${t.status_line}.`}` : ''}</p>}
          {stream.map((item) => item.kind === 'turn'
            ? <CoordinationTurn key={item.turn.key} turn={item.turn} />
            : <div key={item.event.id} className="space-y-1 rounded-lg bg-muted/50 p-3">
                <p className="font-medium">{String(item.event.payload.by ?? 'You')} → {bot}</p>
                <p className="whitespace-pre-wrap break-words">{String(item.event.payload.text ?? '')}</p>
                {Array.isArray(item.event.payload.attachments) && (item.event.payload.attachments as { name: string }[]).length > 0 && <p className="text-xs text-muted-foreground">Files: {(item.event.payload.attachments as { name: string }[]).map((a) => a.name).join(', ')}</p>}
              </div>)}
        </section>
        {t && (brief || files.length > 0 || t.resources.length > 0 || (detail?.events.length ?? 0) > 0) && <details className="rounded-lg border bg-background">
          <summary className="cursor-pointer p-2 text-xs font-medium">Details{detail?.events.length ? ` · ${detail.events.length} events` : ''}</summary>
          <div className="space-y-2 p-2 text-xs">
            {brief && <p className="whitespace-pre-wrap">{more ? brief : short}{brief.length > 280 && <button type="button" className="ml-1 underline" onClick={() => setMore(!more)}>{more ? 'less' : 'more'}</button>}</p>}
            {t.resources.length > 0 && <p className="text-muted-foreground">Uses: {t.resources.join(', ')}</p>}
            {files.length > 0 && <p className="text-muted-foreground">Files you sent: {files.map((f) => f.name).join(', ')}</p>}
            {(detail?.events.length ?? 0) > 0 && <ol className="divide-y">
              {detail!.events.map((e) => <li key={e.id} className="py-1"><span className="text-muted-foreground">{ago(e.at)} ago · {e.kind}</span>{typeof e.payload.status_line === 'string' ? <p className="mt-0.5">{e.payload.status_line}</p> : null}</li>)}
            </ol>}
          </div>
        </details>}
      </div>
      <div className="border-t p-2">
        <p className="px-1 pb-1 text-xs font-medium">Write to {bot} about this task</p>
        <BotComposer conversationId={conversationId} botName={bot} busy={sending} onSend={send} />
        {note && <p role="status" className="px-1 pt-1 text-xs text-muted-foreground">{note}</p>}
      </div>
    </section>
  );
}

/** One customer-thread message: readable text, photos inline, PDFs as chips, quoted history folded. */
export function ThreadBody({ message: m }: { message: CustomerThreadData['messages'][number] }) {
  const [earlier, setEarlier] = useState(false);
  const text = m.text ?? m.body;
  const files = m.files ?? m.attachments.map((a) => ({ name: a.name, kind: 'file' as const, url: null }));
  const images = files.filter((f) => f.kind === 'image' && f.url);
  const others = files.filter((f) => !(f.kind === 'image' && f.url));
  return <>
    {text && <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>}
    {images.length > 0 && <div className="mt-2 flex flex-wrap gap-2">
      {images.map((f) => <a key={f.url} href={f.url!} target="_blank" rel="noreferrer" title={f.name} className="block">
        <img src={f.url!} alt={f.name} loading="lazy" className="h-32 w-32 rounded-lg border bg-background object-cover sm:h-40 sm:w-40" />
      </a>)}
    </div>}
    {others.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">
      {others.map((f, i) => f.url
        ? <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 rounded-full border bg-background px-3 text-xs underline-offset-2 hover:underline">{f.kind === 'pdf' ? 'PDF' : 'File'} · {f.name}</a>
        : <span key={`${f.name}-${i}`} className="inline-flex min-h-9 items-center rounded-full border px-3 text-xs text-muted-foreground">{f.name}</span>)}
    </div>}
    {m.earlier && <div className="mt-1">
      <button type="button" className="min-h-9 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>{earlier ? 'Hide earlier message' : 'Show earlier message'}</button>
      {earlier && <p className="mt-1 whitespace-pre-wrap break-words border-l-2 pl-2 text-xs text-muted-foreground">{m.earlier}</p>}
    </div>}
  </>;
}

/** The real OrderOps thread behind a task (customer on the left, us on the right), read-only, collapsed until the human wants it. */
export function CustomerThreadSection({ conversationId, taskId, caseKey, bot }: { conversationId: string; taskId: string; caseKey: string | null; bot: string }) {
  const [open, setOpen] = useState<boolean>(() => customerThreadPreferred());
  const [data, setData] = useState<CustomerThreadData | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try { setData(await tasksApi.customerThread(conversationId, taskId, refresh)); }
    catch (e) { setData({ ticket: null, messages: [], checked_at: null, error: (e as Error).message }); }
    finally { setBusy(false); }
  }, [conversationId, taskId]);
  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [open, load]);
  const toggle = () => { const next = !open; setOpen(next); rememberCustomerThread(next); };
  return <section aria-label="Customer thread" className="rounded-xl border">
    <div className="flex items-center justify-between gap-2 p-2">
      <button type="button" className="min-h-9 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground" aria-expanded={open} onClick={toggle}>
        Customer thread{caseKey ? ` · ${caseKey}` : ''} · {open ? 'Hide' : 'Show'}
      </button>
      {open && <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {data?.checked_at && <span>Checked OrderOps {ago(data.checked_at)} ago</span>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(true)}>Refresh</Button>
      </div>}
    </div>
    {open && <div className="space-y-2 border-t p-2">
      {!data && <p className="text-xs text-muted-foreground">Reading the ticket from OrderOps…</p>}
      {data?.error && !data.ticket && <p className="text-sm text-muted-foreground">{data.error.startsWith('No ticket code') ? `No ticket code on this task; ask ${bot} to add it.` : data.error}</p>}
      {data?.ticket && <p className="text-xs text-muted-foreground">{data.ticket.subject || `Ticket ${data.ticket.code ?? ''}`} · {data.ticket.customer_name || data.ticket.customer_email || 'customer'}{data.error ? ` · last check failed: ${data.error}` : ''}</p>}
      {data?.ticket && data.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages on this ticket yet.</p>}
      {data?.messages.map((m) => <div key={m.id} className={cn('flex', m.direction === 'in' ? 'justify-start' : 'justify-end')}>
        <div className={cn('max-w-[85%] rounded-xl p-3 text-sm', m.direction === 'in' ? 'bg-muted' : 'bg-primary/10')}>
          <p className="text-xs text-muted-foreground">{m.direction === 'in' ? (m.author_label || 'Customer') : (m.author_label || 'Us')} · {new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{m.channel ? ` · ${m.channel}` : ''}</p>
          <ThreadBody message={m} />
        </div>
      </div>)}
    </div>}
  </section>;
}
