import { BOT_PREFERENCES_CHANGED } from './BotActions';
import { Bot, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { botsApi } from '@/lib/bots';
import { useBotGroups } from '@/lib/botGroups';
import { isPeopleConversation } from '@/lib/teamRooms';

export function useChatUnread(restricted = false) {
  const { groups } = useBotGroups('', restricted);
  const [bots, setBots] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      void botsApi.list('all').then(r => {
        if (active) setBots(r.bots.filter(b => b.unread).length);
      }).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener(BOT_PREFERENCES_CHANGED, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return {
    people: groups.filter(g => isPeopleConversation(g) && g.unread > 0).length,
    bots: bots + groups.filter(g => !isPeopleConversation(g) && g.unread > 0).length,
  };
}

export function ChatUnread({ people, bots }: { people: number; bots: number }) {
  return <span className="flex items-center justify-center gap-1" aria-label={`${people} unread people conversations, ${bots} unread bot conversations`}>
    {people > 0 && <span title="Unread People conversations" className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-900 tabular-nums dark:bg-blue-950 dark:text-blue-100"><Users aria-hidden="true" className="size-3" />{people > 99 ? '99+' : people}</span>}
    {bots > 0 && <span title="Unread Bots conversations" className="inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-900 tabular-nums dark:bg-violet-950 dark:text-violet-100"><Bot aria-hidden="true" className="size-3" />{bots > 99 ? '99+' : bots}</span>}
  </span>;
}
