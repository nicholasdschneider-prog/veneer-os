import { useEffect, useState } from 'react';
import { Bot as BotIcon, CalendarClock, Hand } from 'lucide-react';
import { api } from '@/lib/api';
import { botsApi, type Bot } from '@/lib/bots';
import { BotAvatar } from '@/components/BotIdentity';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { SplitView, SplitPlaceholder } from '@/components/layout/SplitView';
import type { ProjectFileLocation } from '@/lib/projectFilesRoute';
import type { ToastAction } from '@/components/ui/toast';
import { Bots } from './Bots';

type Automation = Awaited<ReturnType<typeof api.focusedAutomations>>['automations'][number];

export function FocusedAutomations({ automations, onNavigate }: { automations: Automation[]; onNavigate: (hash: string) => void }) {
  return <section className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
    <div><h1 className="text-xl font-semibold">Automations</h1><p className="mt-1 text-sm text-muted-foreground">Scheduled work for your bots. Open the bot to discuss a change.</p></div>
    {automations.length === 0 ? <p className="rounded-lg border p-5 text-muted-foreground">Your assigned bots have no routines yet.</p> :
      automations.map(item => <article key={item.id} className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-medium">{item.name}</h2><span className="rounded-full bg-muted px-2 py-1 text-xs">{item.enabled ? 'Active' : 'Paused'}</span></div>
        <p className="mt-2 text-sm text-muted-foreground">{item.schedule} · {item.timezone}</p>
        {item.enabled && item.nextRunAt && <p className="mt-1 text-sm text-muted-foreground">Next: {new Date(item.nextRunAt).toLocaleString(undefined, { timeZone: item.timezone })}</p>}
        <button className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4" onClick={() => onNavigate(`#/chat/${item.botId}?from=bots`)}>Open {item.botName}</button>
      </article>)}
  </section>;
}

// Full native chat preserves assigned browser access, attachments and skill training.
// Only navigation is simplified; the server enforces the selected bot scope.
export function FocusedWorkspace({ hash, email, onNavigate, onToast }: {
  hash: string; email: string; onNavigate: (hash: string) => void; onToast: (message: string, action?: ToastAction) => void;
}) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [error, setError] = useState('');
  const [browser, setBrowser] = useState<string | null>(null);
  const [files, setFiles] = useState<{ project: string; file: ProjectFileLocation } | null>(null);
  const path = hash.split('?')[0] ?? '';
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const selectedId = /^#\/chat\/([^/]+)$/.exec(path)?.[1];
  const chat = bots?.find(bot => bot.conversation_id === selectedId);
  const isAutomations = path === '#/automations' || path === '#/scheduled';
  const decisionId = /^#\/bots\/([^/]+)$/.exec(path)?.[1];
  const work = path === '#/bots' && params.get('view') === 'work';
  useEffect(() => { setBrowser(null); setFiles(null); }, [selectedId]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [list, routines] = await Promise.all([botsApi.list('all'), api.focusedAutomations()]);
        if (active) { setBots(list.bots); setAutomations(routines.automations); setError(''); }
      } catch { if (active) { setBots(null); setAutomations(null); setError('Could not load your workspace. Please refresh to try again.'); } }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const sidebar = <aside className="flex h-full flex-col gap-2 p-4">
    <h1 className="mb-2 text-lg font-semibold">Your bots</h1>
    <button className="mb-2 flex min-h-11 items-center gap-2 rounded-lg border px-3 text-left text-sm" onClick={() => onNavigate('#/bots?view=work')}><Hand className="size-4" />Needs input{bots ? ` (${bots.reduce((sum, bot) => sum + bot.questions, 0)})` : ''}</button>
    {bots?.map(bot => <button key={bot.conversation_id} aria-current={chat?.conversation_id === bot.conversation_id ? 'page' : undefined}
      className="flex min-h-14 items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted aria-[current=page]:bg-muted"
      onClick={() => onNavigate(`#/chat/${bot.conversation_id}?from=bots`)}>
      <BotAvatar id={bot.conversation_id} name={bot.name} /><span className="min-w-0 flex-1 break-words font-medium">{bot.name}</span>{bot.unread && <span className="size-2 rounded-full bg-primary" aria-label="Unread" />}
    </button>)}
    {bots?.length === 0 && <p className="text-sm text-muted-foreground">No bots are assigned yet. Contact your workspace owner.</p>}
  </aside>;
  return <div className="flex h-dvh flex-col bg-background">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-5">
      <nav aria-label="Main navigation" className="flex gap-1">
        <button aria-current={!isAutomations ? 'page' : undefined} className="flex min-h-11 items-center gap-2 rounded-lg px-3 font-medium hover:bg-muted aria-[current=page]:bg-muted" onClick={() => onNavigate('#/bots')}><BotIcon className="size-4" />VeneerBots</button>
        <button aria-current={isAutomations ? 'page' : undefined} className="flex min-h-11 items-center gap-2 rounded-lg px-3 font-medium hover:bg-muted aria-[current=page]:bg-muted" onClick={() => onNavigate('#/automations')}><CalendarClock className="size-4" />Automations</button>
      </nav>
      <span className="max-w-full truncate text-xs text-muted-foreground">{email}</span>
    </header>
    <main className="min-h-0 flex-1 overflow-auto">
      {error ? <p role="alert" className="p-5">{error}</p> : !bots || !automations ? <p role="status" className="p-5">Loading your workspace…</p> : isAutomations ? <FocusedAutomations automations={automations} onNavigate={onNavigate} /> :
        decisionId || work ? <Bots restricted canCall decisionId={decisionId} onNavigate={onNavigate} /> :
        <SplitView storageKey="split:focused-bots" mobileShows={chat ? 'detail' : 'sidebar'} sidebar={sidebar}>
          {chat ? <ChatWorkspace key={chat.conversation_id} conversationId={chat.conversation_id} backHash="#/bots"
            focusMessageId={params.get('message')} artifactParam={params.get('artifact')}
            projectFilesId={files?.project ?? null} projectFile={files?.file ?? null} projectBrowserId={browser}
            onCloseProjectFiles={() => setFiles(null)} onOpenProjectFile={(project, file) => { setBrowser(null); setFiles({ project, file }); }} onClearProjectFile={() => setFiles(null)}
            onOpenProjectBrowser={project => { setFiles(null); setBrowser(project); }} onCloseProjectBrowser={() => setBrowser(null)}
            onNavigate={onNavigate} onToast={onToast} /> : <SplitPlaceholder title="Choose your bot" hint="Open a bot to ask a question or continue your work." />}
        </SplitView>}
    </main>
  </div>;
}
