import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChatTasksToggle } from '@/components/chat/ChatTasksToggle';
import { CHAT_DECISIONS_CHANGED } from '@/components/chat/OpenQuestionsPanel';
import { BOARD_GROUPS, cleanTaskTitle, tasksApi, type Board, type BoardGroup, type BoardRow, type TaskEvent } from '@/lib/tasks';
import { cn } from '@/lib/utils';

/**
 * The TASKS view of a bot chat (shared Tasks capability): everything in flight
 * for this bot in one list, grouped by what the human has to do next. Rows open
 * the existing card, thread or chat; a task row expands to its record, a
 * discussion box, and Mark done. Status comes from source state, so coming back
 * hours later shows the truth, not the last chat claim.
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

export function TasksBoard({ conversationId, onNavigate }: { conversationId: string; onNavigate: (hash: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
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
  return (
    <section aria-label="Tasks" className="conversation-surface flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-card">
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
          {g.rows.map((row) => <li key={`${row.kind}:${row.id}`} data-row-kind={row.kind}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-3">
              {row.can_mark ? <input type="checkbox" aria-label={`Mark ${row.title} done`} className="mt-1 size-4" checked={false} onChange={() => void mark(row, 'done')} />
                : <span aria-hidden="true" className={cn('mt-1.5 size-2.5 rounded-full', dotColor[row.group])} />}
              <button className="min-w-0 text-left" onClick={() => row.kind === 'task' ? setOpen(open === row.id ? null : row.id) : onNavigate(row.href)}>
                <span className="block font-medium leading-snug">{row.task ? cleanTaskTitle(row.title, row.task.case_key) : row.title}</span>
                <span className="block truncate text-xs text-muted-foreground"><span className={cn(row.group === 'needs_input' && 'text-amber-700 dark:text-amber-300', row.group === 'ready_for_review' && 'text-emerald-700 dark:text-emerald-300')}>{row.status_line}</span></span>
                <span className="block text-xs text-muted-foreground">{row.tag}</span>
              </button>
              <span className="text-xs text-muted-foreground">{ago(row.updated_at)}</span>
            </div>
            {row.kind === 'task' && open === row.id && row.task && <TaskDetail conversationId={conversationId} row={row} onNavigate={onNavigate} onChanged={refresh} />}
          </li>)}
        </ul>
      </section>)}
      <div className="h-6" />
    </section>
  );
}

function TaskDetail({ conversationId, row, onNavigate, onChanged }: { conversationId: string; row: BoardRow; onNavigate: (hash: string) => void; onChanged: () => Promise<void> }) {
  const task = row.task!;
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const key = useRef(crypto.randomUUID());
  useEffect(() => { tasksApi.task(conversationId, task.id).then((r) => setEvents(r.events)).catch(() => {}); }, [conversationId, task.id, task.updated_at]);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await tasksApi.discuss(conversationId, task.id, { text: body, request_key: key.current }); key.current = crypto.randomUUID(); setText(''); setNote('Sent to the bot for this task.'); await onChanged(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  };
  const brief = task.brief.trim();
  const short = brief.length > 280 ? `${brief.slice(0, 280).trimEnd()}…` : brief;
  const [more, setMore] = useState(false);
  const chatHref = task.thread_id ? `#/chat/${conversationId}?side=coordination:${task.thread_id}` : null;
  return <div className="space-y-3 border-t bg-muted/30 p-3 text-sm">
    <p className="font-medium">{task.status_line || 'No status yet'}</p>
    <div className="flex flex-wrap gap-2">
      {task.open_decision && <Button size="sm" onClick={() => onNavigate(`#/chat/${conversationId}?side=decision:${task.open_decision!.id}`)}>Answer the question</Button>}
      {chatHref && <Button size="sm" variant="outline" onClick={() => onNavigate(chatHref)}>Open task chat</Button>}
      {task.status !== 'done' && <Button size="sm" variant="outline" onClick={async () => { await tasksApi.mark(conversationId, { kind: 'task', id: task.id, mark: 'done' }); await onChanged(); }}>Mark it done</Button>}
    </div>
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="block text-xs font-medium">Write to the bot about this task
        <textarea className="mt-1 block w-full rounded-lg border bg-background p-2 text-sm" rows={2} value={text} placeholder="Direction for this task only" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      </label>
      <div className="flex items-center gap-3"><Button type="submit" size="sm" disabled={busy || !text.trim()}>Send</Button>{note && <span role="status" className="text-xs text-muted-foreground">{note}</span>}</div>
    </form>
    {(brief || events.length > 0 || task.resources.length > 0) && <details className="rounded-lg border bg-background">
      <summary className="cursor-pointer p-2 text-xs font-medium">Details{task.case_key ? ` · case ${task.case_key}` : ''}{events.length ? ` · ${events.length} events` : ''}</summary>
      <div className="space-y-2 p-2 text-xs">
        {brief && <p className="whitespace-pre-wrap">{more ? brief : short}{brief.length > 280 && <button type="button" className="ml-1 underline" onClick={() => setMore(!more)}>{more ? 'less' : 'more'}</button>}</p>}
        {task.resources.length > 0 && <p className="text-muted-foreground">Uses: {task.resources.join(', ')}</p>}
        {events.length > 0 && <ol className="divide-y">
          {events.map((e) => <li key={e.id} className="py-1"><span className="text-muted-foreground">{ago(e.at)} ago · {e.kind}</span>{typeof e.payload.text === 'string' ? <p className="mt-0.5 whitespace-pre-wrap">{String(e.payload.by ?? '')}: {String(e.payload.text).slice(0, 400)}</p> : typeof e.payload.status_line === 'string' ? <p className="mt-0.5">{e.payload.status_line}</p> : null}</li>)}
        </ol>}
      </div>
    </details>}
  </div>;
}
