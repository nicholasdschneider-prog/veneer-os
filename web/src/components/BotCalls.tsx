import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { requestJson } from '@/lib/api';
import { BotAvatar } from './BotIdentity';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { useLiveVoice } from './VoiceProvider';

export type BotCallRing = { decisionId: string; conversationId: string; botName: string; question: string; remainingMs: number };
type Settings = { dnd: boolean; windowStart: string; windowEnd: string; timezone: string; bots: { conversationId: string; name: string; enabled: boolean }[] };
const POLL_MS = 4000;
const post = <T,>(path: string, body: unknown) => requestJson<T>(`/api/bot-calls/${path}`, { method: 'POST', body: JSON.stringify(body) });

/** The decision a tapped call notification points at, or null. */
export function answerCallTarget(hash: string): string | null {
  const match = /^#\/answer-call\/([^/?#]+)$/.exec(hash);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}

/** A soft two-tone ring. Browsers keep it silent until the page has been touched once. */
function startRingtone(): () => void {
  let context: AudioContext | null = null;
  let timer = 0;
  try {
    context = new AudioContext();
    const chime = () => {
      if (!context || context.state !== 'running') return;
      for (const [offset, frequency] of [[0, 587], [0.22, 784]] as const) {
        const tone = context.createOscillator();
        const gain = context.createGain();
        const at = context.currentTime + offset;
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.12, at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
        tone.connect(gain).connect(context.destination);
        tone.start(at);
        tone.stop(at + 0.45);
      }
    };
    void context.resume().then(chime).catch(() => {});
    timer = window.setInterval(chime, 2000);
  } catch { /* no audio: the card still shows */ }
  return () => { window.clearInterval(timer); void context?.close().catch(() => {}); };
}

/**
 * A bot with a waiting question rings here first. Answer opens the live call on that
 * question; Decline or no answer leaves the question on the desk and the bot tries later.
 */
export function BotCallRing({ enabled }: { enabled: boolean }) {
  const voice = useLiveVoice();
  const [ring, setRing] = useState<BotCallRing | null>(null);
  const [error, setError] = useState('');
  const active = useRef(true);
  const serial = useRef(0);
  useEffect(() => {
    if (!enabled) { setRing(null); return; }
    let alive = true;
    const touched = () => { active.current = true; };
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      const seq = ++serial.current;
      const wasActive = active.current; active.current = false;
      try {
        const next = await post<{ ring: BotCallRing | null }>('poll', { active: wasActive });
        if (alive && seq === serial.current) setRing(next.ring);
      } catch { if (wasActive) active.current = true; }
    };
    // A tapped call notification lands on #/answer-call/<decision>: ring it here, then show its card.
    const tapped = () => {
      const id = answerCallTarget(window.location.hash);
      if (!id) return;
      window.location.replace(`#/bots/${encodeURIComponent(id)}`);
      ++serial.current;
      void post<{ ring: BotCallRing | null }>('ring', { decisionId: id })
        .then(next => { if (alive) { setRing(next.ring); if (!next.ring) setError('That call is no longer waiting. The question is on your desk.'); } })
        .catch(() => {});
    };
    tapped();
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const wake = () => { tapped(); void poll(); };
    window.addEventListener('pointerdown', touched, true);
    window.addEventListener('keydown', touched, true);
    window.addEventListener('focus', wake);
    window.addEventListener('hashchange', tapped);
    window.addEventListener('voice-session-ended', wake);
    return () => {
      alive = false; ++serial.current; window.clearInterval(timer);
      window.removeEventListener('pointerdown', touched, true);
      window.removeEventListener('keydown', touched, true);
      window.removeEventListener('focus', wake);
      window.removeEventListener('hashchange', tapped);
      window.removeEventListener('voice-session-ended', wake);
    };
  }, [enabled]);
  const ringing = ring && !voice.pinnedId ? ring : null;
  const key = ringing?.decisionId;
  useEffect(() => {
    if (!key) return;
    // Load the call screen while it rings so Answer connects straight away.
    void import('../screens/LiveVoice').catch(() => {});
    const stop = startRingtone();
    // The server ends the ring; this only covers a tab that cannot reach it.
    const timeout = window.setTimeout(() => setRing(current => current?.decisionId === key ? null : current), (ringing?.remainingMs ?? 0) + POLL_MS);
    return () => { stop(); window.clearTimeout(timeout); };
  }, [key]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const answer = () => {
    if (!ringing) return;
    const call = ringing;
    ++serial.current; setRing(null);
    // Opened inside the tap so the microphone and audio start without a second press.
    voice.open(call.conversationId, call.decisionId, { incoming: true });
    void post('answer', { decisionId: call.decisionId }).catch(() => {});
  };
  const decline = () => {
    if (!ringing) return;
    const id = ringing.decisionId;
    ++serial.current; setRing(null);
    void post('decline', { decisionId: id }).catch(() => {});
  };
  if (!ringing) return error ? <p role="status" className="fixed bottom-[calc(env(safe-area-inset-bottom)+8.5rem)] right-3 z-50 max-w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border bg-background p-3 text-sm lg:bottom-20">{error}</p> : null;
  return <section role="alertdialog" aria-label={`${ringing.botName} is calling`} className="fixed bottom-[calc(env(safe-area-inset-bottom)+8.5rem)] right-3 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl border bg-background p-4 shadow-xl lg:bottom-20">
    <div className="flex items-center gap-3">
      <span className="motion-safe:animate-pulse"><BotAvatar id={ringing.conversationId} name={ringing.botName} /></span>
      <div className="min-w-0">
        <p className="text-base font-medium sm:text-sm">{ringing.botName} is calling</p>
        <p className="line-clamp-2 break-words text-base text-muted-foreground sm:text-sm">{ringing.question}</p>
      </div>
    </div>
    <div className="flex gap-2">
      <Button type="button" className="min-h-11 flex-1 bg-green-600 text-white hover:bg-green-500" onClick={answer}><Phone className="size-4" /> Answer</Button>
      <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={decline}><PhoneOff className="size-4" /> Decline</Button>
    </div>
  </section>;
}

/** Who may ring you, and when. Personal settings: they change nobody else's calls and no bot's access. */
export function BotCallSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void requestJson<Settings>('/api/bot-calls/settings').then(s => { if (alive) setSettings(s); }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, []);
  const save = async (change: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { setSettings(await post<Settings>('settings', change)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!settings) return <p role={error ? 'alert' : 'status'} className="border-b p-3 text-sm text-muted-foreground">{error || 'Loading call settings…'}</p>;
  const time = 'min-h-11 rounded-md border bg-background px-2 text-base';
  return <div className="max-h-[60%] space-y-3 overflow-y-auto border-b p-3 text-base sm:text-sm">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-3">
      <div><p className="font-medium">Do not disturb</p><p className="text-muted-foreground">No bot rings you. Questions still line up here.</p></div>
      <Switch checked={settings.dnd} disabled={busy} aria-label="Do not disturb" onCheckedChange={() => void save({ dnd: !settings.dnd })} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">Call me from<input type="time" name="call-window-start" className={time} value={settings.windowStart} disabled={busy} onChange={e => { if (e.target.value) void save({ windowStart: e.target.value }); }} /></label>
      <label className="flex items-center gap-2">to<input type="time" name="call-window-end" className={time} value={settings.windowEnd} disabled={busy} onChange={e => { if (e.target.value) void save({ windowEnd: e.target.value }); }} /></label>
    </div>
    <p className="text-muted-foreground">Eastern time. Outside these hours a bot can still ring while you are using Veneer. A missed call is tried again every 15 minutes.</p>
    <p className="font-medium">Bots that can call me</p>
    {!settings.bots.length && <p className="text-muted-foreground">No bots yet.</p>}
    <ul className="space-y-1">
      {settings.bots.map(bot => <li key={bot.conversationId} className="flex min-h-11 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2"><BotAvatar id={bot.conversationId} name={bot.name} /><span className="truncate">{bot.name}</span></span>
        <Switch checked={bot.enabled} disabled={busy} aria-label={`${bot.name} can call me`} onCheckedChange={() => void save({ bot: { conversationId: bot.conversationId, enabled: !bot.enabled } })} />
      </li>)}
    </ul>
  </div>;
}
