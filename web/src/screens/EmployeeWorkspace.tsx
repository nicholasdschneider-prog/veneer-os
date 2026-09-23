import { TeamMessages } from './TeamMessages';
import { useRoomUnread } from '@/lib/teamRooms';
import { BotGuide } from './BotGuide';
import { Bots } from './Bots';
import { useBotInputCount } from '@/components/NavBar';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { BotConversationRail } from '@/components/BotConversationRail';
import { SplitView } from '@/components/layout/SplitView';
import type { ToastAction } from '@/components/ui/toast';

export function EmployeeWorkspace({ hash, onNavigate, email, onToast }: { hash: string; onNavigate: (hash: string) => void; email: string; onToast: (message: string, action?: ToastAction) => void }) {
  const unread = useRoomUnread();
  const count = useBotInputCount('bots');
  const path = hash.split('?')[0] ?? '';
  // Employees can open existing assigned bots, never the new-chat flow.
  const chatId = /^#\/chat\/([^/]+)$/.exec(path)?.[1];
  const existingChatId = chatId && chatId !== 'new' ? chatId : undefined;
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const unavailable = () => onToast('This feature is not available in the customer service workspace.');
  const decisionId = path.startsWith('#/bots/') ? path.split('/')[2] : undefined;
  return <div className="flex h-dvh flex-col bg-background">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <button className="flex min-h-11 items-center gap-2 font-semibold" onClick={() => onNavigate('#/bots')}>
        Customer Service <span aria-label={`${count} questions needing input`} className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-black tabular-nums">{count}</span>
      </button>
      <button className="min-h-11 text-sm" onClick={() => onNavigate('#/messages')}>Messages {unread > 0 ? `(${unread})` : ''}</button>
      <button className="min-h-11 text-sm underline underline-offset-4" onClick={() => onNavigate('#/bot-guide')}>Bot guide</button>
      <span className="break-all text-xs text-muted-foreground">{email}</span>
    </header>
    <main className="min-h-0 flex-1 overflow-auto">
      {path === '#/messages' || path.startsWith('#/messages/') ? <TeamMessages restricted roomId={path.split('/')[2]} fromBots={params.get("from")==="bots"} onNavigate={onNavigate} /> : path === '#/bot-guide' ? <BotGuide hash={hash} onNavigate={onNavigate} /> : existingChatId ? <SplitView
        storageKey="split:chats"
        mobileShows="detail"
        sidebar={<BotConversationRail selectedId={existingChatId} onNavigate={onNavigate} restricted />}
      >
        <ChatWorkspace
          key={existingChatId}
          conversationId={existingChatId}
          restricted
          backHash="#/bots"
          focusMessageId={params.get('message')}
          artifactParam={null}
          projectFilesId={null}
          projectFile={null}
          projectBrowserId={null}
          onCloseProjectFiles={unavailable}
          onOpenProjectFile={unavailable}
          onClearProjectFile={unavailable}
          onOpenProjectBrowser={unavailable}
          onCloseProjectBrowser={unavailable}
          onNavigate={onNavigate}
          onToast={onToast}
        />
      </SplitView> :
        <Bots restricted canCall decisionId={decisionId} onNavigate={onNavigate} />}
    </main>
  </div>;
}
