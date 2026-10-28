import { useEffect, useState } from 'react';
import { ListChecks, MessageSquare } from 'lucide-react';
import { Button } from '../ui/button';
import { tasksApi, tasksViewHash, TASKS_VIEW_KEY } from '@/lib/tasks';
import { CHAT_DECISIONS_CHANGED } from './OpenQuestionsPanel';

/** Polls the board count for one chat; shared by the header toggle and the board. */
export function useTasksCount(conversationId: string, enabled = true): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !conversationId || conversationId === 'new') return;
    let stop = false;
    const load = () => tasksApi.board(conversationId).then((b) => { if (!stop) setCount(b.needs_you); }).catch(() => {});
    void load();
    const timer = setInterval(load, 30000);
    window.addEventListener(CHAT_DECISIONS_CHANGED, load);
    return () => { stop = true; clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, load); };
  }, [conversationId, enabled]);
  return count;
}

/** CHAT | TASKS: the two views of one bot chat. The chosen view is remembered per chat. */
export function ChatTasksToggle({ conversationId, view, onNavigate }: { conversationId: string; view: 'chat' | 'tasks'; onNavigate: (hash: string) => void }) {
  const count = useTasksCount(conversationId, view === 'chat');
  const go = (next: 'chat' | 'tasks') => {
    try { localStorage.setItem(TASKS_VIEW_KEY(conversationId), next); } catch { /* ignore */ }
    onNavigate(tasksViewHash(conversationId, next === 'tasks'));
  };
  return <div role="tablist" aria-label="Chat or tasks" className="flex shrink-0 items-center rounded-full border p-0.5">
    <Button role="tab" aria-selected={view === 'chat'} variant={view === 'chat' ? 'secondary' : 'ghost'} size="sm" className="min-h-9 gap-1 rounded-full" onClick={() => go('chat')}>
      <MessageSquare className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Chat</span>
    </Button>
    <Button role="tab" aria-selected={view === 'tasks'} variant={view === 'tasks' ? 'secondary' : 'ghost'} size="sm" className="min-h-9 gap-1 rounded-full" onClick={() => go('tasks')}>
      <ListChecks className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Tasks</span>
      {count ? <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-black tabular-nums">{count}</span> : null}
    </Button>
  </div>;
}
