import { useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { voiceRequest, type VoiceSnapshot } from '@/lib/liveVoice';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
type Session = {
  id: string;
  started_ms: number;
  connected_ms: number | null;
  duration_ms: number;
  outcome: string;
};
export function voiceDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function VoiceSessions({ conversationId }: { conversationId: string }) {
  const epoch = useRef(0);
  const earlierExhausted = useRef(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [earlierBusy, setEarlierBusy] = useState(false);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState<Session | null>(null);
  const [entries, setEntries] = useState<VoiceSnapshot['history']>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      voiceRequest<{ sessions: Session[] }>(
        `/sessions?bot=${encodeURIComponent(conversationId)}`,
      )
        .then((data) => {
          if (active) {
            setSessions((old) => [
              ...data.sessions,
              ...old.filter((s) => !data.sessions.some((n) => n.id === s.id)),
            ]);
            if (!earlierExhausted.current)
              setHasEarlier((old) => old || data.sessions.length === 50);
          }
        })
        .catch(() => {});
    setSessions([]);
    setSelected(null);
    setHasEarlier(false);
    earlierExhausted.current = false;
    setListError('');
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener('voice-session-ended', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('voice-session-ended', refresh);
    };
  }, [conversationId]);
  useEffect(() => {
    epoch.current++;
    if (!selected) return;
    let active = true;
    setBusy(true);
    setError('');
    setEntries([]);
    setNext(null);
    void voiceRequest<{
      entries: VoiceSnapshot['history'];
      next: number | null;
    }>(`/sessions/${selected.id}`)
      .then((data) => {
        if (active) {
          setEntries(data.entries);
          setNext(data.next);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);
  async function earlier() {
    const last = sessions.at(-1);
    if (!last || earlierBusy) return;
    setEarlierBusy(true);
    setListError('');
    try {
      const data = await voiceRequest<{ sessions: Session[] }>(
        `/sessions?bot=${encodeURIComponent(conversationId)}&before_ms=${last.started_ms}&before_id=${encodeURIComponent(last.id)}`,
      );
      setSessions((old) => [
        ...old,
        ...data.sessions.filter((s) => !old.some((n) => n.id === s.id)),
      ]);
      earlierExhausted.current = data.sessions.length < 50;
      setHasEarlier(data.sessions.length === 50);
    } catch (e) {
      setListError(
        e instanceof Error ? e.message : 'Could not load earlier calls.',
      );
    } finally {
      setEarlierBusy(false);
    }
  }
  async function more() {
    if (!selected || next === null || busy) return;
    const id = selected.id;
    const current = epoch.current;
    setBusy(true);
    setError('');
    try {
      const data = await voiceRequest<{
        entries: VoiceSnapshot['history'];
        next: number | null;
      }>(`/sessions/${id}?after=${next}`);
      if (current === epoch.current) {
        setEntries((old) => [...old, ...data.entries]);
        setNext(data.next);
      }
    } catch (e) {
      if (current === epoch.current)
        setError(e instanceof Error ? e.message : 'Could not load transcript.');
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Your saved voice sessions" className="space-y-2">
      {[...sessions].reverse().map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => setSelected(session)}
          className="flex min-h-14 w-full items-center gap-3 rounded-3xl bg-muted/60 px-4 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <AudioLines className="size-5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Voice chat</span>
            <span className="block text-xs text-muted-foreground">
              {new Date(session.started_ms).toLocaleString()} ·{' '}
              {session.connected_ms === null
                ? 'Did not connect'
                : session.outcome === 'interrupted'
                  ? 'Interrupted'
                  : session.outcome === 'failed'
                    ? 'Disconnected'
                    : 'Transcript'}
            </span>
          </span>
          <span className="tabular-nums text-muted-foreground">
            {voiceDuration(session.duration_ms)}
          </span>
        </button>
      ))}
      {hasEarlier && (
        <button
          type="button"
          onClick={() => void earlier()}
          disabled={earlierBusy}
          className="min-h-11 rounded-full border px-4 text-sm"
        >
          {earlierBusy ? 'Loading…' : 'Earlier voice chats'}
        </button>
      )}
      {listError && <p role="alert">{listError}</p>}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>
            Voice chat · {voiceDuration(selected?.duration_ms ?? 0)}
          </DialogTitle>
          <DialogDescription>
            Saved transcript, visible to you. Audio was not recorded.
          </DialogDescription>
          {busy && <p role="status">Loading transcript…</p>}
          {error && <p role="alert">{error}</p>}
          {!busy && !error && !entries.length && (
            <p className="text-muted-foreground">
              No transcript was received for this call.
            </p>
          )}
          <ol className="space-y-5">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.role === 'user'
                    ? 'ml-8 text-right text-muted-foreground'
                    : 'mr-8'
                }
              >
                <p className="text-xs">
                  {entry.role === 'user'
                    ? 'You'
                    : entry.role === 'decision'
                      ? 'Decision delivered'
                      : 'Bot'}
                </p>
                <p className="whitespace-pre-wrap break-words leading-relaxed">
                  {entry.text}
                </p>
              </li>
            ))}
          </ol>
          {next !== null && (
            <button
              type="button"
              className="min-h-11 rounded-xl border p-2"
              disabled={busy}
              onClick={() => void more()}
            >
              Load more transcript
            </button>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
