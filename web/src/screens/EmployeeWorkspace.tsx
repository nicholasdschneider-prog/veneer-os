import { Markdown } from '@/components/Markdown';
import { useEffect, useState } from 'react';
import { Bots } from './Bots';
import { api } from '@/lib/api';
import { botsApi } from '@/lib/bots';
import { Button } from '@/components/ui/button';
import { useBotInputCount } from '@/components/NavBar';
import type { ConversationEvent } from '@/lib/types';

export function EmployeeWorkspace({ hash, onNavigate, email }: { hash: string; onNavigate: (hash: string) => void; email: string }) {
  const count = useBotInputCount('bots');
  const path = hash.split('?')[0] ?? '';
  const chatId = path.startsWith('#/chat/') ? path.split('/')[2] : undefined;
  const decisionId = path.startsWith('#/bots/') ? path.split('/')[2] : undefined;
  return <div className="flex h-dvh flex-col bg-background">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <button className="flex min-h-11 items-center gap-2 font-semibold" onClick={() => onNavigate('#/bots')}>
        Customer Service <span aria-label={`${count} questions needing input`} className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-black tabular-nums">{count}</span>
      </button>
      <span className="break-all text-xs text-muted-foreground">{email}</span>
    </header>
    <main className="min-h-0 flex-1 overflow-auto">
      {chatId ? <EmployeeChat key={chatId} id={chatId} onBack={() => onNavigate('#/bots')} /> :
        <Bots restricted decisionId={decisionId} onNavigate={onNavigate} />}
    </main>
  </div>;
}

function EmployeeChat({ id, onBack }: { id: string; onBack: () => void }) {
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [name, setName] = useState('Bot conversation');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [list, transcript] = await Promise.all([botsApi.list('all'), api.transcript(id)]);
        if (!active) return;
        const bot = list.bots.find(b => b.conversation_id === id);
        if (!bot) throw new Error('This bot is not available to your account.');
        setName(bot.name); setEvents(transcript.events); setStatus(transcript.status); setAllowed(true); setError('');
      } catch (e) {
        if (active) { setEvents([]); setAllowed(false); setError((e as Error).message); }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [id]);
  const messages = events.filter(e => e.type === 'turn_started' || e.type === 'text_final');
  return <section className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
    <div className="flex items-center gap-3"><Button variant="outline" onClick={onBack}>Back to questions</Button><h1 className="text-xl font-semibold">{name}</h1></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="space-y-4" aria-label="Conversation">
      {messages.map((event, i) => <article key={i} className="rounded-xl border p-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{event.type === 'turn_started' ? 'Message to bot' : name}</p>
        <div className="break-words text-sm"><Markdown markdown={event.type === 'turn_started' ? String(event.text ?? '') : event.type === 'text_final' ? String(event.markdown ?? '') : ''} /></div>
      </article>)}
    </div>
    <p role="status" className="text-xs text-muted-foreground">{status === 'working' ? `${name} is working…` : 'Conversation updates every few seconds.'}</p>
    <form className="sticky bottom-0 space-y-2 border-t bg-background py-4" onSubmit={e => {
      e.preventDefault(); if (busy || !allowed || !text.trim()) return;
      setBusy(true); setError('');
      void api.sendMessage(id, text.trim()).then(() => setText('')).catch(e => setError(e.message)).finally(() => setBusy(false));
    }}>
      <label htmlFor="employee-message" className="text-sm font-medium">Message {name}</label>
      <textarea id="employee-message" className="min-h-24 w-full rounded-lg border bg-background p-3 text-sm" value={text} onChange={e => setText(e.target.value)} disabled={!allowed || busy} />
      <Button disabled={!allowed || busy || !text.trim()} type="submit">{busy ? 'Sending…' : 'Send message'}</Button>
    </form>
  </section>;
}
