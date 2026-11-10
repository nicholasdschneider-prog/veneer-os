import { useEffect, useState } from 'react';
import { Chat } from '@/screens/Chat';
import { TasksBoard } from '@/screens/TasksBoard';
import { TASKS_VIEW_KEY } from '@/lib/tasks';
import { botsApi } from '@/lib/bots';
import type { ToastAction } from './ui/toast';
import { deskRoute } from './QuestionDesk';

/**
 * One bot in its own browser window (popped out of the dock). Its Chat | Tasks
 * switch stays in the window; anything else opens in the main Veneer window.
 */
export function PopOutChat({ conversationId, onToast }: { conversationId: string; onToast: (message: string, action?: ToastAction) => void }) {
  const [view, setView] = useState<'chat' | 'tasks'>(() => {
    try { return localStorage.getItem(TASKS_VIEW_KEY(conversationId)) === 'tasks' ? 'tasks' : 'chat'; } catch { return 'chat'; }
  });
  const [task, setTask] = useState<string | null>(null);
  useEffect(() => {
    void botsApi.preferences(conversationId, { unread: false }).catch(() => {});
  }, [conversationId]);
  const navigate = (hash: string) => {
    const route = deskRoute(conversationId, hash);
    if (route && 'view' in route) { setView(route.view); setTask(route.view === 'tasks' ? route.taskId : null); return; }
    const main = window.opener as Window | null;
    try {
      if (main && !main.closed && main.location.origin === window.location.origin) { main.location.hash = hash; main.focus(); return; }
    } catch { /* the opener is gone or another origin: open here instead */ }
    window.location.hash = hash;
  };
  return <>
    <div className={view === 'chat' ? 'h-full min-h-0' : 'hidden'}>
      <Chat conversationId={conversationId} artifacts={[]} onOpenArtifact={() => undefined} onRefreshArtifacts={async () => []} onPublishArtifact={async () => undefined} onOpenCitations={() => undefined} onOpenProjectFile={() => undefined} onNavigate={navigate} onToast={onToast} openQuestionsButton={false} />
    </div>
    {view === 'tasks' && <div className="flex h-full min-h-0 flex-col"><TasksBoard compact conversationId={conversationId} taskId={task} onNavigate={navigate} /></div>}
  </>;
}
