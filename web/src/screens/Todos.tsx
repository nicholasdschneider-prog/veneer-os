import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  GripVertical,
  Link2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { micDictation } from '../lib/stt';
import { finalizedDictatedTodoTitle, joinTodoDictation } from '../lib/todoDictation';
import { todoNewChatHash } from '../lib/todoChatPrompt';
import type { Project, Todo, TodoCategory, TodoLink } from '../lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// The implicit, always-first column for todos with no category (categoryId null).
const INBOX_KEY = '__inbox__';

type State = Todo['state'];
type TodoDictationPhase = 'recording' | 'finalizing' | 'adding';

interface TodoDictationTarget {
  key: string;
  categoryId: string | null;
}

function byOrder<T extends { sortOrder: number }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder;
}

/** Where sits a sort order that lands a card at `index` of `colAll`, ignoring the dragged card. */
function computeSortOrder(colAll: Todo[], index: number, draggedId: string): number {
  const left = [...colAll.slice(0, index)].reverse().find((t) => t.id !== draggedId);
  const right = colAll.slice(index).find((t) => t.id !== draggedId);
  if (!left && !right) return 0;
  if (!left) return right!.sortOrder - 1;
  if (!right) return left.sortOrder + 1;
  return (left.sortOrder + right.sortOrder) / 2;
}

const IS_COARSE = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;

interface Column {
  key: string;
  categoryId: string | null;
  name: string;
  category: TodoCategory | null;
}

/**
 * Scratch-pad Todos screen (#/todos). Todos hold a title, notes and link/file
 * attachments; they live in user-defined category columns plus an implicit
 * "Inbox". A todo is 'pending' (a note to self) or 'active' (fired off as a
 * chat). The Pending/Active toggle switches which state each column shows.
 * Pointer drag reorders and moves cards on fine pointers;
 * on touch the detail sheet's category select is the move fallback.
 */
export function Todos({
  onToast,
  onNavigate,
}: {
  onToast: (message: string) => void;
  onNavigate: (hash: string) => void;
}) {
  const [data, setData] = useState<{ categories: TodoCategory[]; todos: Todo[] } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<State>('pending');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [menuCatId, setMenuCatId] = useState<string | null>(null);
  const [quickAddDrafts, setQuickAddDrafts] = useState<Record<string, string>>({});
  const [dictation, setDictation] = useState<{ key: string; phase: TodoDictationPhase } | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ key: string; index: number } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dragOverRef = useRef<{ key: string; index: number } | null>(null);
  const draggingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const dictationSessionRef = useRef(0);
  const dictationTargetRef = useRef<TodoDictationTarget | null>(null);
  const dictationBaseRef = useRef('');
  const dictationValueRef = useRef('');
  const dictationHasCommittedSpeechRef = useRef(false);

  const load = useCallback(() => {
    void Promise.all([api.todos(), api.projects().catch(() => ({ projects: [] as Project[] }))])
      .then(([todoResult, projectResult]) => {
        if (!draggingRef.current) {
          setData({ categories: todoResult.categories, todos: todoResult.todos });
          setProjects(projectResult.projects);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dictationSessionRef.current++;
      dictationTargetRef.current = null;
      micDictation.stop('cancel');
    };
  }, []);

  const todos = data?.todos ?? null;
  const categories = data ? [...data.categories].sort(byOrder) : [];

  const columns: Column[] = [
    { key: INBOX_KEY, categoryId: null, name: 'Inbox', category: null },
    ...categories.map((c) => ({ key: c.id, categoryId: c.id, name: c.name, category: c })),
  ];

  const countFor = (s: State) => todos?.filter((t) => t.state === s).length ?? 0;

  const detailTodo = detailId ? (todos?.find((t) => t.id === detailId) ?? null) : null;
  useEffect(() => {
    if (detailId && todos && !todos.find((t) => t.id === detailId)) setDetailId(null);
  }, [detailId, todos]);
  const menuCat = menuCatId ? (categories.find((c) => c.id === menuCatId) ?? null) : null;
  useEffect(() => {
    if (menuCatId && data && !data.categories.find((c) => c.id === menuCatId)) setMenuCatId(null);
  }, [menuCatId, data]);

  // Central move: PATCH categoryId + sortOrder, optimistic, revert-by-reload.
  const applyMove = useCallback(
    async (id: string, categoryId: string | null, sortOrder: number) => {
      setData((prev) =>
        prev ? { ...prev, todos: prev.todos.map((t) => (t.id === id ? { ...t, categoryId, sortOrder } : t)) } : prev,
      );
      try {
        await api.updateTodo(id, { categoryId, sortOrder });
        load();
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Move failed');
        load();
      }
    },
    [load, onToast],
  );

  const quickAdd = useCallback(
    async (categoryId: string | null, title: string) => {
      try {
        await api.createTodo({ title, categoryId });
        load();
        return true;
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Could not add todo');
        return false;
      }
    },
    [load, onToast],
  );

  const setQuickAddDraft = useCallback((key: string, value: string) => {
    setQuickAddDrafts((current) => ({ ...current, [key]: value }));
  }, []);

  const cancelTodoDictation = useCallback(() => {
    dictationSessionRef.current++;
    dictationTargetRef.current = null;
    setDictation(null);
    micDictation.stop('cancel');
  }, []);

  const selectView = useCallback(
    (next: State) => {
      if (next !== 'pending' && dictation) cancelTodoDictation();
      setView(next);
    },
    [cancelTodoDictation, dictation],
  );

  const toggleTodoDictation = useCallback(
    (target: TodoDictationTarget) => {
      if (dictation) {
        if (dictation.key === target.key && dictation.phase === 'recording') micDictation.stop();
        return;
      }

      // A previous screen should cancel its session while unmounting. This is a
      // final guard against inheriting a microphone session with stale handlers.
      if (micDictation.isActive || micDictation.isFinalizing) micDictation.stop('cancel');

      const session = ++dictationSessionRef.current;
      let errorReported = false;
      const isCurrent = () => mountedRef.current && dictationSessionRef.current === session;
      dictationTargetRef.current = target;
      dictationBaseRef.current = quickAddDrafts[target.key] ?? '';
      dictationValueRef.current = dictationBaseRef.current;
      dictationHasCommittedSpeechRef.current = false;
      setDictation({ key: target.key, phase: 'recording' });

      void micDictation
        .start({
          onPartial: (text) => {
            if (!isCurrent()) return;
            const next = joinTodoDictation(dictationBaseRef.current, text);
            dictationValueRef.current = next;
            setQuickAddDraft(target.key, next);
          },
          onCommitted: (text) => {
            if (!isCurrent()) return;
            if (text.trim()) dictationHasCommittedSpeechRef.current = true;
            dictationBaseRef.current = joinTodoDictation(dictationBaseRef.current, text);
            dictationValueRef.current = dictationBaseRef.current;
            setQuickAddDraft(target.key, dictationBaseRef.current);
          },
          onFinalizing: () => {
            if (isCurrent()) setDictation({ key: target.key, phase: 'finalizing' });
          },
          onError: (message) => {
            if (!isCurrent()) return;
            errorReported = true;
            onToast(message);
          },
          onEnd: (reason) => {
            if (!isCurrent()) return;
            const currentTarget = dictationTargetRef.current;
            const title = finalizedDictatedTodoTitle(
              reason,
              dictationHasCommittedSpeechRef.current,
              dictationValueRef.current,
            );
            if (!currentTarget || !title) {
              dictationTargetRef.current = null;
              setDictation(null);
              return;
            }

            setDictation({ key: currentTarget.key, phase: 'adding' });
            void quickAdd(currentTarget.categoryId, title).then((created) => {
              if (!isCurrent()) return;
              if (created) setQuickAddDraft(currentTarget.key, '');
              dictationTargetRef.current = null;
              setDictation(null);
            });
          },
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          if (!errorReported) onToast(err instanceof Error ? err.message : 'Could not access microphone');
          dictationTargetRef.current = null;
          setDictation(null);
        });
    },
    [dictation, onToast, quickAdd, quickAddDrafts, setQuickAddDraft],
  );

  // Flip a fired-off todo between active and done straight from its card.
  const setTodoState = useCallback(
    async (id: string, state: State, toast: string) => {
      setData((prev) => (prev ? { ...prev, todos: prev.todos.map((t) => (t.id === id ? { ...t, state } : t)) } : prev));
      try {
        await api.updateTodo(id, { state });
        onToast(toast);
        load();
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Update failed');
        load();
      }
    },
    [load, onToast],
  );

  const moveCategory = useCallback(
    async (cat: TodoCategory, dir: 'left' | 'right') => {
      const i = categories.findIndex((c) => c.id === cat.id);
      const j = dir === 'left' ? i - 1 : i + 1;
      const other = categories[j];
      if (!other) return;
      try {
        await Promise.all([
          api.updateTodoCategory(cat.id, { sortOrder: other.sortOrder }),
          api.updateTodoCategory(other.id, { sortOrder: cat.sortOrder }),
        ]);
        load();
      } catch (err) {
        onToast(err instanceof Error ? err.message : 'Move failed');
      }
    },
    [categories, load, onToast],
  );

  // --- Pointer drag (fine pointers only) ---------------------------------
  const onGripDown = (e: React.PointerEvent, id: string) => {
    if (IS_COARSE) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragIdRef.current = id;
    draggingRef.current = true;
    setDragId(id);
  };

  const onGripMove = (e: React.PointerEvent) => {
    if (!dragIdRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    const { clientX, clientY } = e;
    let overKey: string | null = null;
    for (const col of Array.from(root.querySelectorAll<HTMLElement>('[data-col]'))) {
      const r = col.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) {
        overKey = col.dataset.col ?? null;
        break;
      }
    }
    if (!overKey) return;
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>(`[data-list="${CSS.escape(overKey)}"] [data-task-id]`),
    );
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i]!.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    const next = { key: overKey, index };
    dragOverRef.current = next;
    setDragOver(next);
  };

  const onGripUp = (e: React.PointerEvent) => {
    const id = dragIdRef.current;
    const over = dragOverRef.current;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    dragIdRef.current = null;
    dragOverRef.current = null;
    draggingRef.current = false;
    setDragId(null);
    setDragOver(null);
    if (!id || !over || !todos) return;
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const categoryId = over.key === INBOX_KEY ? null : over.key;
    const colAll = todos.filter((t) => t.categoryId === categoryId && t.state === view).sort(byOrder);
    const sortOrder = computeSortOrder(colAll, over.index, id);
    if (todo.categoryId === categoryId && todo.sortOrder === sortOrder) return;
    void applyMove(id, categoryId, sortOrder);
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-6">
        <h1 className="text-2xl font-semibold">Todos</h1>
        <div className="flex max-w-full min-w-0 items-center gap-2 overflow-x-auto pb-1 sm:max-w-none sm:overflow-visible sm:pb-0">
          <div className="flex shrink-0 rounded-xl bg-muted p-0.5 text-sm font-medium">
            {(['pending', 'active', 'done'] as State[]).map((s) => (
              <button
                key={s}
                onPointerUp={() => selectView(s)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 capitalize transition-colors',
                  view === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground',
                )}
              >
                {s}
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs',
                    view === s ? 'bg-muted text-muted-foreground' : 'bg-transparent',
                  )}
                >
                  {countFor(s)}
                </span>
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="h-9 shrink-0 gap-1.5 rounded-xl" onPointerUp={() => setNewCatOpen(true)}>
            <Plus className="size-4" /> Category
          </Button>
        </div>
      </header>

      {data === null ? (
        <p className="px-2 py-16 text-center text-muted-foreground">Loading…</p>
      ) : (
        <div
          ref={rootRef}
          className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:snap-none"
        >
          {columns.map((col) => {
            const colTodos = (todos ?? [])
              .filter((t) => t.categoryId === col.categoryId && t.state === view)
              .sort(byOrder);
            const isOver = dragOver?.key === col.key;
            return (
              <section
                key={col.key}
                data-col={col.key}
                className="flex min-h-0 w-[85vw] shrink-0 snap-start flex-col md:w-auto md:min-w-0 md:flex-1"
              >
                <div className="flex items-center gap-2 px-2 pb-2">
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{col.name}</h2>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {colTodos.length}
                  </span>
                  {col.category ? (
                    <button
                      aria-label={`${col.name} options`}
                      onPointerUp={() => setMenuCatId(col.category!.id)}
                      className="shrink-0 rounded-md p-0.5 text-muted-foreground active:bg-accent"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  ) : null}
                </div>

                <div
                  data-list={col.key}
                  className={cn(
                    'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-xl p-1.5',
                    isOver && 'bg-accent/40',
                  )}
                >
                  {view === 'pending' ? (
                    <QuickAdd
                      value={quickAddDrafts[col.key] ?? ''}
                      onChange={(value) => setQuickAddDraft(col.key, value)}
                      onAdd={(title) => quickAdd(col.categoryId, title)}
                      dictationPhase={dictation?.key === col.key ? dictation.phase : null}
                      dictationDisabled={dictation !== null && dictation.key !== col.key}
                      onToggleDictation={() => toggleTodoDictation({ key: col.key, categoryId: col.categoryId })}
                    />
                  ) : null}

                  {colTodos.length === 0 ? (
                    <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                      {view === 'pending' ? 'Nothing here yet.' : view === 'active' ? 'No active todos.' : 'Nothing done yet.'}
                    </p>
                  ) : null}

                  {colTodos.map((t, i) => (
                    <div key={t.id}>
                      {isOver && dragOver?.index === i ? (
                        <div className="mb-2 h-0.5 rounded-full bg-primary" />
                      ) : null}
                      <TodoCard
                        todo={t}
                        projectName={projects.find((project) => project.id === t.projectId)?.name ?? null}
                        dimmed={dragId === t.id}
                        onOpen={() => setDetailId(t.id)}
                        onNavigate={onNavigate}
                        onArchive={() => void setTodoState(t.id, 'done', 'Marked done')}
                        onReopen={() => void setTodoState(t.id, 'active', 'Reopened')}
                        onGripDown={(e) => onGripDown(e, t.id)}
                        onGripMove={onGripMove}
                        onGripUp={onGripUp}
                      />
                    </div>
                  ))}
                  {isOver && dragOver?.index === colTodos.length ? (
                    <div className="h-0.5 rounded-full bg-primary" />
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <NewCategoryDialog
        open={newCatOpen}
        onOpenChange={setNewCatOpen}
        onCreated={() => {
          setNewCatOpen(false);
          load();
        }}
        onToast={onToast}
      />

      {menuCat ? (
        <CategoryMenu
          category={menuCat}
          canMoveLeft={categories.findIndex((c) => c.id === menuCat.id) > 0}
          canMoveRight={categories.findIndex((c) => c.id === menuCat.id) < categories.length - 1}
          onClose={() => setMenuCatId(null)}
          onMove={(dir) => void moveCategory(menuCat, dir)}
          onReload={load}
          onToast={onToast}
        />
      ) : null}

      {detailTodo ? (
        <TodoDetail
          todo={detailTodo}
          categories={categories}
          projects={projects}
          onClose={() => setDetailId(null)}
          onNavigate={onNavigate}
          onReload={load}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}

function QuickAdd({
  value,
  onChange,
  onAdd,
  dictationPhase,
  dictationDisabled,
  onToggleDictation,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: (title: string) => Promise<boolean>;
  dictationPhase: TodoDictationPhase | null;
  dictationDisabled: boolean;
  onToggleDictation: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const locked = dictationPhase !== null || submitting;
  const submit = async () => {
    if (locked) return;
    const t = value.trim();
    if (!t) return;
    setSubmitting(true);
    try {
      if (await onAdd(t)) onChange('');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          readOnly={locked}
          placeholder="+ Add a todo…"
          aria-label="New todo"
          className="min-w-0 flex-1 rounded-xl border border-dashed border-border bg-card/50 px-3 py-2 text-[16px] outline-none placeholder:text-muted-foreground focus:border-ring"
        />
        <button
          type="button"
          onPointerUp={onToggleDictation}
          disabled={dictationDisabled || dictationPhase === 'finalizing' || dictationPhase === 'adding' || submitting}
          aria-label={
            dictationPhase === 'recording'
              ? 'Stop dictation and add todo'
              : dictationPhase === 'finalizing'
                ? 'Finishing dictation'
                : dictationPhase === 'adding'
                  ? 'Adding dictated todo'
                  : 'Dictate a new todo'
          }
          aria-pressed={dictationPhase === 'recording'}
          className={cn(
            'relative flex size-10 shrink-0 items-center justify-center rounded-full border border-dashed border-border bg-card/50 transition-colors',
            dictationPhase === 'recording'
              ? 'border-destructive/50 text-destructive'
              : 'text-muted-foreground hover:text-foreground',
            (dictationDisabled || dictationPhase === 'finalizing' || dictationPhase === 'adding' || submitting) &&
              'opacity-50',
          )}
        >
          {dictationPhase === 'recording' ? (
            <span className="absolute inset-1.5 animate-ping rounded-full bg-destructive/35" />
          ) : null}
          <Mic className="relative size-4.5" />
        </button>
      </div>
      {dictationPhase ? (
        <p role="status" className="px-2 pt-1 text-xs text-muted-foreground">
          {dictationPhase === 'recording'
            ? 'Listening… Tap the mic to add.'
            : dictationPhase === 'finalizing'
              ? 'Finishing dictation…'
              : 'Adding todo…'}
        </p>
      ) : null}
    </div>
  );
}

function linkCounts(links: TodoLink[]): { links: number; files: number } {
  return {
    links: links.filter((l) => l.kind === 'link').length,
    files: links.filter((l) => l.kind === 'file').length,
  };
}

function TodoCard({
  todo,
  projectName,
  dimmed,
  onOpen,
  onNavigate,
  onArchive,
  onReopen,
  onGripDown,
  onGripMove,
  onGripUp,
}: {
  todo: Todo;
  projectName: string | null;
  dimmed: boolean;
  onOpen: () => void;
  onNavigate: (hash: string) => void;
  onArchive: () => void;
  onReopen: () => void;
  onGripDown: (e: React.PointerEvent) => void;
  onGripMove: (e: React.PointerEvent) => void;
  onGripUp: (e: React.PointerEvent) => void;
}) {
  const isActive = todo.state === 'active';
  const isDone = todo.state === 'done';
  const pendingProjectName = todo.state === 'pending' ? projectName : null;
  const counts = linkCounts(todo.links);
  // Active/done cards: the whole face opens the linked chat (or the sheet if it
  // has no chat yet); a small edit icon opens the detail sheet instead.
  const primary = () => {
    if (isActive || isDone) {
      if (todo.conversationId) onNavigate(`#/chat/${todo.conversationId}`);
      else onOpen();
    } else {
      onOpen();
    }
  };

  return (
    <div
      data-task-id={todo.id}
      className={cn(
        'relative flex gap-1 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 transition-shadow',
        isActive && 'ring-brand/40',
        isDone && 'opacity-70',
        dimmed && 'opacity-40',
      )}
    >
      <button onPointerUp={primary} className="min-w-0 flex-1 text-left">
        <div className="flex items-start gap-2">
          {isActive ? <MessageSquare className="mt-0.5 size-4 shrink-0 text-brand" /> : null}
          {isDone ? <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
          <p
            className={cn(
              'min-w-0 flex-1 font-medium leading-snug',
              isDone && 'text-muted-foreground line-through',
            )}
          >
            {todo.title}
          </p>
        </div>
        {todo.notes.trim() ? (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{todo.notes.trim()}</p>
        ) : null}
        {pendingProjectName || counts.links > 0 || counts.files > 0 ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {pendingProjectName ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Folder className="size-3.5 shrink-0" />
                <span className="truncate">{pendingProjectName}</span>
              </span>
            ) : null}
            {counts.links > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Link2 className="size-3.5" /> {counts.links}
              </span>
            ) : null}
            {counts.files > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Paperclip className="size-3.5" /> {counts.files}
              </span>
            ) : null}
          </div>
        ) : null}
      </button>

      <div className="-mr-1 flex shrink-0 items-center gap-1">
        {isActive ? (
          <button
            aria-label="Archive todo"
            onPointerUp={onArchive}
            className="rounded-md p-1 text-muted-foreground active:bg-accent"
          >
            <Archive className="size-[18px]" />
          </button>
        ) : null}
        {isDone ? (
          <button
            aria-label="Reopen todo"
            onPointerUp={onReopen}
            className="rounded-md p-1 text-muted-foreground active:bg-accent"
          >
            <RotateCcw className="size-[18px]" />
          </button>
        ) : null}
        {isActive || isDone ? (
          <button
            aria-label="Edit todo"
            onPointerUp={onOpen}
            className="rounded-md p-1 text-muted-foreground active:bg-accent"
          >
            <Pencil className="size-[18px]" />
          </button>
        ) : null}
        {!IS_COARSE ? (
          <button
            aria-label="Drag todo"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            className="flex cursor-grab touch-none items-center p-1 text-muted-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-[18px]" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TodoDetail({
  todo,
  categories,
  projects,
  onClose,
  onNavigate,
  onReload,
  onToast,
}: {
  todo: Todo;
  categories: TodoCategory[];
  projects: Project[];
  onClose: () => void;
  onNavigate: (hash: string) => void;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [links, setLinks] = useState<TodoLink[]>(todo.links);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const dirty = title.trim() !== todo.title || notes !== todo.notes;

  // Persist a links set (replace-all) and reflect it locally + upstream.
  const persistLinks = async (next: TodoLink[]) => {
    setLinks(next);
    try {
      await api.updateTodo(todo.id, {
        links: next.map((l) => ({ kind: l.kind, href: l.href, label: l.label })),
      });
      onReload();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not save links');
      setLinks(todo.links);
    }
  };

  const saveText = async () => {
    if (!title.trim() || busy || !dirty) return;
    setBusy(true);
    try {
      await api.updateTodo(todo.id, { title: title.trim(), notes });
      onReload();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const changeCategory = async (categoryId: string | null) => {
    try {
      await api.updateTodo(todo.id, { categoryId });
      onReload();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not move');
    }
  };

  const changeProject = async (projectId: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateTodo(todo.id, { projectId });
      onReload();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not assign project');
    } finally {
      setBusy(false);
    }
  };

  const addLink = () => {
    const href = newUrl.trim();
    if (!href) return;
    const link: TodoLink = { id: crypto.randomUUID(), kind: 'link', href, label: newLabel.trim() || null };
    setNewUrl('');
    setNewLabel('');
    void persistLinks([...links, link]);
  };

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    for (const file of Array.from(list)) {
      void api
        .uploadFile(file)
        .then((meta) => {
          const link: TodoLink = { id: crypto.randomUUID(), kind: 'file', href: meta.path, label: meta.name };
          setLinks((cur) => {
            const next = [...cur, link];
            void api
              .updateTodo(todo.id, { links: next.map((l) => ({ kind: l.kind, href: l.href, label: l.label })) })
              .then(onReload)
              .catch((err: unknown) => onToast(err instanceof Error ? err.message : 'Could not save file'));
            return next;
          });
        })
        .catch((err: unknown) => onToast(err instanceof Error ? err.message : 'Upload failed'));
    }
  };

  const removeLink = (id: string) => void persistLinks(links.filter((l) => l.id !== id));

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteTodo(todo.id);
      onReload();
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
    }
  };

  // Manual state moves for a fired-off todo: mark it done, or reopen it. Keeps
  // conversationId intact so the linked chat stays reachable either way.
  const changeState = async (state: State, toast: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateTodo(todo.id, { state });
      onReload();
      onToast(toast);
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Update failed');
      setBusy(false);
    }
  };

  const fileLinks = links.filter((l) => l.kind === 'file');
  const urlLinks = links.filter((l) => l.kind === 'link');

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-md">
        {confirmDelete ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete this todo?</DialogTitle>
              <DialogDescription>This can't be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => setConfirmDelete(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => void doDelete()}
                disabled={busy}
              >
                Delete
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-base leading-snug">
                {todo.state === 'active' ? 'Active todo' : todo.state === 'done' ? 'Done' : 'Todo'}
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Notes <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  className="resize-none rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
              </label>
              {dirty ? (
                <Button
                  size="sm"
                  className="self-start rounded-lg"
                  onPointerUp={() => void saveText()}
                  disabled={busy || !title.trim()}
                >
                  Save changes
                </Button>
              ) : null}

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Category</span>
                <select
                  value={todo.categoryId ?? ''}
                  onChange={(e) => void changeCategory(e.target.value || null)}
                  className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                >
                  <option value="">Inbox</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              {todo.state === 'pending' && projects.length > 0 ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Project</span>
                  <select
                    value={todo.projectId ?? ''}
                    onChange={(e) => void changeProject(e.target.value || null)}
                    disabled={busy}
                    className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                  >
                    <option value="">No project</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Links</span>
                {urlLinks.length ? (
                  <ul className="flex flex-col gap-1">
                    {urlLinks.map((l) => (
                      <li key={l.id} className="flex items-center gap-2">
                        <a
                          href={l.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-primary active:underline"
                        >
                          <ExternalLink className="size-3.5 shrink-0" />
                          <span className="min-w-0 truncate">{l.label || l.href}</span>
                        </a>
                        <button
                          aria-label="Remove link"
                          onPointerUp={() => removeLink(l.id)}
                          className="shrink-0 rounded-md p-1 text-muted-foreground active:bg-accent"
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://…"
                    spellCheck={false}
                    autoCapitalize="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addLink();
                      }
                    }}
                    className="rounded-lg border bg-card px-3 py-2 text-[16px] outline-none focus:border-ring"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="Label (optional)"
                      className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2 text-[16px] outline-none focus:border-ring"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-9 shrink-0 rounded-lg"
                      onPointerUp={addLink}
                      disabled={!newUrl.trim()}
                      aria-label="Add link"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Files</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 rounded-lg"
                    onPointerUp={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="size-3.5" /> Attach
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
                {fileLinks.length ? (
                  <AttachmentGroup>
                    {fileLinks.map((l) => (
                      <Attachment key={l.id} size="sm">
                        <AttachmentMedia>
                          <FileText />
                        </AttachmentMedia>
                        <AttachmentContent>
                          <AttachmentTitle>{l.label || l.href}</AttachmentTitle>
                        </AttachmentContent>
                        <AttachmentActions>
                          <AttachmentAction aria-label="Remove file" onPointerUp={() => removeLink(l.id)}>
                            <X />
                          </AttachmentAction>
                        </AttachmentActions>
                      </Attachment>
                    ))}
                  </AttachmentGroup>
                ) : null}
              </div>
            </div>

            {todo.state === 'pending' ? (
              <Button
                className="h-11 w-full gap-2 rounded-xl"
                disabled={busy}
                onPointerUp={() => onNavigate(todoNewChatHash(todo.id, todo.projectId))}
              >
                <Send className="size-4" /> Fire off as chat
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="h-11 w-full gap-2 rounded-xl"
                  disabled={!todo.conversationId}
                  onPointerUp={() => todo.conversationId && onNavigate(`#/chat/${todo.conversationId}`)}
                >
                  <MessageSquare className="size-4" /> Open chat
                </Button>
                {todo.state === 'active' ? (
                  <Button
                    variant="outline"
                    className="h-11 w-full gap-2 rounded-xl"
                    disabled={busy}
                    onPointerUp={() => void changeState('done', 'Marked done')}
                  >
                    <CheckCircle2 className="size-4" /> Mark done
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="h-11 w-full gap-2 rounded-xl"
                    disabled={busy}
                    onPointerUp={() => void changeState('active', 'Reopened')}
                  >
                    <RotateCcw className="size-4" /> Reopen
                  </Button>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="ghost"
                className="h-11 w-full gap-2 rounded-xl text-destructive"
                onPointerUp={() => setConfirmDelete(true)}
                disabled={busy}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CategoryMenu({
  category,
  canMoveLeft,
  canMoveRight,
  onClose,
  onMove,
  onReload,
  onToast,
}: {
  category: TodoCategory;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onClose: () => void;
  onMove: (dir: 'left' | 'right') => void;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState(category.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy || trimmed === category.name) return;
    setBusy(true);
    try {
      await api.updateTodoCategory(category.id, { name: trimmed });
      onReload();
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Rename failed');
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteTodoCategory(category.id);
      onReload();
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="gap-3 sm:max-w-sm">
        {confirmDelete ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete "{category.name}"?</DialogTitle>
              <DialogDescription>Its todos move to Inbox.</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => setConfirmDelete(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => void doDelete()}
                disabled={busy}
              >
                Delete
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Category</DialogTitle>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void rename();
                  }
                }}
                className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
              />
            </label>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 gap-1.5 rounded-lg"
                onPointerUp={() => onMove('left')}
                disabled={!canMoveLeft || busy}
              >
                <ChevronLeft className="size-4" /> Left
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 gap-1.5 rounded-lg"
                onPointerUp={() => onMove('right')}
                disabled={!canMoveRight || busy}
              >
                Right <ChevronRight className="size-4" />
              </Button>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                className="h-11 flex-1 gap-2 rounded-xl text-destructive"
                onPointerUp={() => setConfirmDelete(true)}
                disabled={busy}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
              <Button
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => void rename()}
                disabled={busy || !name.trim() || name.trim() === category.name}
              >
                Rename
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCategoryDialog({
  open,
  onOpenChange,
  onCreated,
  onToast,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setBusy(false);
    }
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await api.createTodoCategory(trimmed);
      onCreated();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Could not add category');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>Add a column to Todos.</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. This week"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
            className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
          />
        </label>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="h-11 flex-1 rounded-xl"
            onPointerUp={() => !busy && onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button className="h-11 flex-1 rounded-xl" onPointerUp={() => void create()} disabled={busy || !name.trim()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
