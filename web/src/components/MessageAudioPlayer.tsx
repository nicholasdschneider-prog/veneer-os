import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { requestJson } from '@/lib/api';

type Source = { chat: string; turn: string; at: string };
type Message = { id: string; parts: number };
type Position = { part: number; seconds: number };
const ListenContext = createContext<(source: Source) => void>(() => {});
export const useMessageListen = () => useContext(ListenContext);
const storageKey = (id: string) => `veneer-listen:${id}`;
export function readListenPosition(id: string, parts: number): Position {
  try {
    const p = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null') as Position | null;
    if (p && Number.isInteger(p.part) && p.part >= 0 && p.part < parts && Number.isFinite(p.seconds) && p.seconds >= 0) return p;
  } catch { /* Storage may be disabled. */ }
  return { part: 0, seconds: 0 };
}

/** Above the router, so the same audio element survives navigation. */
export function MessageAudioProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const epoch = useRef(0);
  const active = useRef<{ message: Message; part: number } | null>(null);
  const resumeAt = useRef(0);
  const rate = useRef(1);
  const [source, setSource] = useState<Source | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [part, setPart] = useState(0);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [speed, setSpeed] = useState(1);
  const save = useCallback(() => {
    const a = active.current;
    if (!a || !audio.current?.src || audio.current.readyState === 0 || audio.current.ended) return;
    try { localStorage.setItem(storageKey(a.message.id), JSON.stringify({ part: a.part, seconds: audio.current.currentTime })); } catch { /* Optional local resume. */ }
  }, []);
  const prepare = useCallback(async (m: Message, index: number, seconds: number, ticket: number) => {
    setBusy(true); setError(''); setUrl('');
    active.current = null;
    try { localStorage.setItem(storageKey(m.id), JSON.stringify({ part: index, seconds })); } catch { /* Optional local resume. */ }
    try {
      const result = await requestJson<{ url: string }>(`/api/bot-communication/message-audio/${m.id}/${index}`, { method: 'POST', body: '{}' });
      if (epoch.current !== ticket) return;
      active.current = { message: m, part: index };
      resumeAt.current = seconds;
      setPart(index); setUrl(result.url);
    } catch (e) {
      if (epoch.current === ticket) setError(e instanceof Error ? e.message : 'Could not prepare audio. Try again.');
    } finally { if (epoch.current === ticket) setBusy(false); }
  }, []);
  const listen = useCallback((next: Source) => {
    save(); audio.current?.pause(); active.current = null;
    const ticket = ++epoch.current;
    setSource(next); setMessage(null); setUrl(''); setBusy(true); setError('');
    void requestJson<Message>(`/api/bot-communication/chats/${encodeURIComponent(next.chat)}/listen`, {
      method: 'POST', body: JSON.stringify({ turn: next.turn, at: next.at }),
    }).then(m => {
      if (epoch.current !== ticket) return;
      setMessage(m);
      const position = readListenPosition(m.id, m.parts);
      setPart(position.part);
      return prepare(m, position.part, position.seconds, ticket);
    }).catch(e => {
      if (epoch.current === ticket) { setBusy(false); setError(e instanceof Error ? e.message : 'Could not prepare audio.'); }
    });
  }, [prepare, save]);
  const changePart = (index: number) => {
    if (!message) return;
    save(); audio.current?.pause(); setPart(index);
    void prepare(message, index, 0, ++epoch.current);
  };
  const close = () => { save(); ++epoch.current; audio.current?.pause(); active.current = null; setSource(null); setUrl(''); };
  useEffect(() => {
    const pause = () => { save(); audio.current?.pause(); };
    const otherMedia = (event: Event) => { if (event.target !== audio.current) pause(); };
    const stopForCall = () => { save(); ++epoch.current; audio.current?.pause(); active.current = null; setSource(null); setUrl(''); setBusy(false); };
    window.addEventListener('veneer-live-voice-opening', stopForCall);
    window.addEventListener('pagehide', save);
    document.addEventListener('play', otherMedia, true);
    return () => { window.removeEventListener('veneer-live-voice-opening', stopForCall); window.removeEventListener('pagehide', save); document.removeEventListener('play', otherMedia, true); };
  }, [save]);
  useEffect(() => {
    if (!url || !navigator.mediaSession) return;
    const session = navigator.mediaSession;
    const seek = (amount: number) => {
      if (audio.current) audio.current.currentTime = Math.max(0, Math.min(audio.current.duration || 0, audio.current.currentTime + amount));
    };
    session.metadata = new MediaMetadata({ title: 'Full message', artist: 'Veneer · AI voice' });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => { void audio.current?.play().catch(() => setError('Tap Play to continue.')); }],
      ['pause', () => audio.current?.pause()],
      ['seekbackward', details => seek(-(details.seekOffset ?? 15))],
      ['seekforward', details => seek(details.seekOffset ?? 15)],
      ['seekto', details => { if (audio.current && details.seekTime !== undefined) audio.current.currentTime = details.seekTime; }],
    ];
    for (const [action, handler] of handlers) { try { session.setActionHandler(action, handler); } catch { /* Browser support varies. */ } }
    return () => { for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ } } session.metadata = null; session.playbackState = 'none'; };
  }, [url]);
  const button = 'min-h-11 rounded-full border px-3 text-sm hover:bg-muted disabled:opacity-50';
  return <ListenContext.Provider value={listen}>
    {children}
    {source && <section aria-label="Listen to full message" className="fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 w-[min(28rem,calc(100vw-1rem))] -translate-x-1/2 rounded-2xl border bg-background p-3 shadow-xl">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">Full message <span className="text-xs text-muted-foreground">· AI voice</span></span><button className={button} onClick={close} aria-label="Close message player">Close</button></div>
      {busy && <p role="status" className="py-2 text-sm">Preparing audio…</p>}
      {url && <audio ref={audio} src={url} controls preload="auto" className="mt-2 h-11 w-full" aria-label="Full message audio"
        onLoadedMetadata={() => {
          const el = audio.current!;
          el.playbackRate = rate.current;
          el.currentTime = Math.min(resumeAt.current, Math.max(0, el.duration - 0.1));
          void el.play().catch(() => setError('Audio is ready. Tap Play to listen.'));
        }}
        onPlay={() => { setError(''); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; }}
        onPause={() => { save(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; }}
        onTimeUpdate={() => {
          save();
          const el = audio.current;
          if (el && Number.isFinite(el.duration) && el.duration > 0) {
            try { navigator.mediaSession?.setPositionState({ duration: el.duration, playbackRate: el.playbackRate, position: Math.min(el.currentTime, el.duration) }); } catch { /* Optional platform control. */ }
          }
        }}
        onError={() => setError('Audio could not play. Choose Retry to prepare it again.')}
        onEnded={() => {
          if (message && part + 1 < message.parts) changePart(part + 1);
          else if (message) { try { localStorage.removeItem(storageKey(message.id)); } catch { /* Optional local resume. */ } }
        }} />}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={button} disabled={!url} onClick={() => { if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime - 15); }}>Back 15s</button>
        <label className="text-sm">Speed <select aria-label="Playback speed" className="min-h-11 rounded-lg border bg-background px-2" value={speed} onChange={e => { const value = Number(e.target.value); rate.current = value; setSpeed(value); if (audio.current) audio.current.playbackRate = value; }}>{[0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
        {message && message.parts > 1 && <label className="text-sm">Section <select aria-label="Audio section" className="min-h-11 rounded-lg border bg-background px-2" disabled={busy} value={part} onChange={e => changePart(Number(e.target.value))}>{Array.from({ length: message.parts }, (_, index) => <option key={index} value={index}>{index + 1} of {message.parts}</option>)}</select></label>}
      </div>
      {error && <p role="status" className="mt-2 text-sm">{error} <button className={button} disabled={busy} onClick={() => listen(source)}>Retry</button></p>}
    </section>}
  </ListenContext.Provider>;
}
