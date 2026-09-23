import { CallButton } from '@/components/CallButton';
import { VoiceCallPanel } from '../components/VoiceCallPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { ArrowLeft, Mic, MicOff, PhoneOff, Pause, Volume2 } from 'lucide-react';
import { micDictation } from '../lib/stt';
import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/BotIdentity';
import { decisionLabel } from '@/lib/bots';
import { voiceRequest, type VoiceSnapshot } from '../lib/liveVoice';

type State = 'ready' | 'connecting' | 'connected' | 'reconnecting' | 'standby' | 'ended';
/**
 * A live voice call. With `botConversationId` it is a call to one VeneerBot
 * (its chat, decisions and questions); without it, the Henry coordinator
 * across every pending question.
 */
export function LiveVoice({ botConversationId, decisionId, onBack, onNavigate, compact = false }: {
  compact?: boolean; botConversationId?: string; decisionId?: string | null; onBack: () => void; onNavigate?: (hash: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
  const [state, setState] = useState<State>('ready');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [contextId, setContextId] = useState('');
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (state !== 'connected') { setLevel(0); return; }
    const timer = window.setInterval(() => {
      const room = roomRef.current;
      setLevel(room ? Math.max(room.localParticipant.audioLevel, ...Array.from(room.remoteParticipants.values(), p => p.audioLevel)) : 0);
    }, 120);
    return () => window.clearInterval(timer);
  }, [state]);
  const roomRef = useRef<Room | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);
  const callId = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const audioHost = useRef<HTMLDivElement>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const query = botConversationId ? `?bot=${encodeURIComponent(botConversationId)}${decisionId ? `&decision=${encodeURIComponent(decisionId)}` : ''}` : '';
  const refresh = useCallback(async () => {
    const next = await voiceRequest<VoiceSnapshot>(query);
    if (mounted.current) setSnapshot(next);
    return next;
  }, [query]);
  const end = useCallback((next: State = 'ended') => {
    generation.current++;
    if (roomRef.current) micDictation.liveVoiceActive = false;
    const id = callId.current; callId.current = null;
    const room = roomRef.current; roomRef.current = null;
    room?.removeAllListeners();
    micRef.current?.stop(); micRef.current = null;
    void room?.disconnect().catch(() => {});
    audioHost.current?.replaceChildren();
    void wakeLock.current?.release(); wakeLock.current = null;
    if (id) void voiceRequest(`/calls/${id}/end`, {}, true).then(() => window.dispatchEvent(new Event('voice-session-ended'))).catch(() => {});
    if (mounted.current) { setState(next); setMuted(false); setAudioBlocked(false); }
  }, []);
  const name = snapshot?.bot?.name ?? (botConversationId ? 'this bot' : 'Henry');
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(e => setError(e.message));
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks++;
      if (!callId.current && ticks % 5 !== 0) return;
      const epoch = generation.current;
      void refresh().then(next => {
        if (epoch === generation.current && callId.current && (!next.call || next.call.id !== callId.current || next.call.state === 'failed')) {
          setError(next.call?.error ?? 'The call ended. Tap Call to continue.'); end();
        }
      }).catch(e => { if (epoch === generation.current) { setError(e.message); end(); } });
      if (callId.current && ticks % 5 === 0) void voiceRequest(`/calls/${callId.current}/heartbeat`, {}).catch(() => {
        if (epoch !== generation.current) return;
        setError('Connection lost. Your saved conversation is still here.'); end();
      });
    }, 2_000);
    const pagehide = () => end();
    const visibility = () => {
      if (document.visibilityState === 'visible' && roomRef.current) {
        void roomRef.current.startAudio().catch(() => setAudioBlocked(true));
        if ('wakeLock' in navigator) {
          const currentRoom = roomRef.current;
          void navigator.wakeLock.request('screen').then(lock => {
            if (currentRoom && roomRef.current === currentRoom) wakeLock.current = lock; else void lock.release();
          }).catch(() => {});
        }
      }
    };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false; window.clearInterval(timer); end();
      window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', visibility);
    };
  }, [refresh, end]);

  async function start() {
    if (roomRef.current) return;
    if (micDictation.isActive || micDictation.isFinalizing || micDictation.liveVoiceActive) { setError('Finish dictation or the other voice call first.'); return; }
    micDictation.liveVoiceActive = true;
    const epoch = ++generation.current;
    setError(null); setState('connecting');
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    // These begin in the actual tap handler, before any network await (iOS).
    const audioReady = room.startAudio().catch(() => { if (mounted.current && generation.current === epoch) setAudioBlocked(true); });
    const micReady = createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach(); element.setAttribute('playsinline', '');
        audioHost.current?.append(element);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()));
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => setState('reconnecting'));
    room.on(RoomEvent.Reconnected, () => setState('connected'));
    room.on(RoomEvent.Disconnected, () => { if (roomRef.current === room) end(); });
    try {
      const mic = await micReady;
      if (generation.current !== epoch) { mic.stop(); return; }
      micRef.current = mic;
      mic.mediaStreamTrack.addEventListener('ended', () => {
        if (micRef.current === mic) { setError('The microphone was disconnected. Check your AirPods or audio route, then reconnect.'); end(); }
      });
      await audioReady;
      const body = botConversationId
        ? { botConversationId, ...(decisionId ? { decisionId } : {}) }
        : contextId ? { contextConversationId: contextId } : {};
      const result = await voiceRequest<{ id: string; url: string; token: string }>('/calls', body);
      if (generation.current !== epoch) { void voiceRequest(`/calls/${result.id}/end`, {}); return; }
      callId.current = result.id;
      await room.connect(result.url, result.token);
      if (generation.current !== epoch) { await room.disconnect(); return; }
      await room.localParticipant.publishTrack(mic);
      if (generation.current !== epoch) return;
      await voiceRequest(`/calls/${result.id}/connected`, {});
      if (generation.current !== epoch) return;
      setState('connected');
      if ('wakeLock' in navigator) {
          const currentRoom = roomRef.current;
          void navigator.wakeLock.request('screen').then(lock => {
            if (currentRoom && roomRef.current === currentRoom) wakeLock.current = lock; else void lock.release();
          }).catch(() => {});
        }
      void refresh().catch(() => {});
    } catch (e) {
      if (generation.current === epoch) {
        setError(e instanceof Error && e.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow the microphone for Veneer in Safari, then try again.'
          : e instanceof Error && e.name === 'NotFoundError' ? 'No microphone was found. Connect your AirPods or another microphone, then try again.'
          : e instanceof Error && e.name === 'NotReadableError' ? 'The microphone is unavailable. Close other audio apps, then reconnect.'
          : e instanceof Error ? e.message : 'Unable to connect. Please try again.');
        end();
      }
    }
  }
  async function toggleMute() {
    const mic = micRef.current;
    if (!mic) return;
    try { if (muted) await mic.unmute(); else await mic.mute(); setMuted(!muted); }
    catch { setError('Could not change the microphone. Reconnect the call.'); }
  }
  const active = state === 'connected' || state === 'connecting' || state === 'reconnecting';
  const status = state === 'connected' ? muted ? 'Microphone muted' : snapshot?.call?.state === 'speaking' ? `${name} is speaking` : snapshot?.call?.state === 'thinking' ? `${name} is checking` : 'Listening' :
    state === 'ended' ? 'Call ended · microphone off' : state === 'standby' ? 'On standby · microphone off' : state === 'connecting' ? 'Connecting…' : state === 'reconnecting' ? 'Reconnecting…' : 'Ready when you are';
  const bot = snapshot?.bot ?? null;
  const focused = snapshot?.decision ?? null;
  const open = (snapshot?.decisions ?? []).filter(d => d.state === 'needs_input' && d.decisionId !== focused?.decisionId);
  const missingBot = !!botConversationId && !!snapshot && !bot;
  if (compact) return <VoiceCallPanel callerName={snapshot?.callerName} name={name} botId={botConversationId ?? ''} status={status} active={active} connected={state === 'connected'} muted={muted} level={level} history={snapshot?.history ?? []} ready={!!snapshot?.configuration.ready && !!bot?.canMessage} onStart={() => void start()} onMute={() => void toggleMute()} onEnd={() => { end(); onBack(); }} onStandby={() => end('standby')}>
    {error && <p role="alert" className="mt-3 px-2 text-sm text-destructive">{error}</p>}
    {snapshot && !snapshot.configuration.ready && <p role="alert" className="mt-3 px-2 text-sm">Voice setup needs attention. Ask your administrator to check {snapshot.configuration.missing.join(', ') || 'LIVEKIT_URL'} in Settings → Credentials.</p>}
    {audioBlocked && active && <Button variant="outline" className="mt-3 min-h-11 w-full" onClick={() => void roomRef.current?.startAudio().catch(() => setError('Tap again to enable audio.'))}><Volume2 className="size-4" />Enable audio</Button>}
    {!active && snapshot?.call && <Button variant="outline" className="mt-3 min-h-11 w-full" onClick={() => void voiceRequest(`/calls/${snapshot.call!.id}/end`, {}).then(refresh).catch(e => setError(e.message))}>End previous call</Button>}
    <div ref={audioHost} className="hidden" />
  </VoiceCallPanel>;
  return <div className="h-full overflow-y-auto px-4 py-6 sm:px-8">
    <main className="mx-auto flex max-w-3xl flex-col gap-8 pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-col gap-4">
        <Button variant="ghost" className="min-h-11 self-start" onClick={() => { end(); onBack(); }}><ArrowLeft className="size-4" /> Back</Button>
        <div className="flex items-start gap-3">
          {bot && <BotAvatar id={bot.conversationId} name={bot.name} />}
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-balance text-3xl font-semibold tracking-tight">{bot ? `Talk with ${bot.name}` : botConversationId ? 'Talk with your bot' : 'Talk to Henry'}</h1>
            <p className="text-pretty text-base text-muted-foreground sm:text-sm">
              {bot ? `${[bot.role, bot.subteam, bot.team].filter(Boolean).join(' · ') || bot.title || 'VeneerBot'}. Work through its open questions out loud; what you decide goes straight back to it.`
                : 'Work through questions together. Your decisions go back to the waiting agents.'}
            </p>
          </div>
        </div>
      </header>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-base text-destructive sm:text-sm">{error}</p>}
      {missingBot && <p role="alert" className="rounded-xl border p-4 text-base sm:text-sm">This bot is not available to call. It may have been returned to Chats or you no longer have access.</p>}
      {snapshot && !snapshot.configuration.ready && <section className="flex flex-col gap-3 rounded-xl border p-5">
        <h2 className="text-lg font-semibold">Finish voice setup</h2>
        <p className="text-base text-muted-foreground sm:text-sm">Connect a <a className="underline" href="https://cloud.livekit.io" target="_blank" rel="noreferrer">LiveKit Cloud project</a> and an <a className="underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">OpenAI API account</a> through Settings → Credentials → Vault.</p>
        <p className="break-words text-base sm:text-sm">Missing: {snapshot.configuration.missing.join(', ') || 'none'}.</p>
        {snapshot.configuration.invalidUrl && <p className="text-base sm:text-sm">LIVEKIT_URL must be your wss://…livekit.cloud project URL.</p>}
        <p className="text-base text-muted-foreground sm:text-sm">Voice uses separately billed API services. ChatGPT and Codex subscriptions do not cover these calls.</p>
        <Button variant="outline" className="min-h-11 self-start" onClick={() => void refresh().catch(e => setError(e.message))}>Check setup again</Button>
      </section>}
      <section className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:p-8" aria-label="Call controls">
        <p role="status" aria-live="polite" className="text-xl font-medium">{status}</p>
        {!active && !botConversationId && <div className="flex flex-col gap-2">
          <label htmlFor="voice-context" className="text-base sm:text-sm">Working context <span className="text-muted-foreground">(optional)</span></label>
          <select id="voice-context" value={contextId} onChange={e => setContextId(e.target.value)} className="min-h-11 w-full rounded-lg border bg-background px-3 text-base">
            <option value="">All my pending questions</option>
            {snapshot?.chats.map(chat => <option key={chat.id} value={chat.id}>{chat.projectName ? `${chat.projectName} · ` : ''}{chat.title ?? 'Untitled chat'}</option>)}
          </select>
        </div>}
        <div className="flex flex-wrap gap-3">
          {!active ? <CallButton className="min-h-12 flex-1" disabled={!snapshot?.configuration.ready || missingBot} onClick={() => void start()}>{state === 'standby' ? 'Resume conversation' : `Call ${bot?.name ?? (botConversationId ? 'bot' : 'Henry')}`}</CallButton> : <>
            <Button variant="outline" className="min-h-12 flex-1" disabled={state !== 'connected'} aria-pressed={muted} onClick={() => void toggleMute()}>{muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}{muted ? 'Unmute' : 'Mute'}</Button>
            <Button variant="outline" className="min-h-12 flex-1" onClick={() => end('standby')}><Pause className="size-4" />Standby</Button>
            <Button variant="destructive" className="min-h-12 flex-1" onClick={() => end()}><PhoneOff className="size-4" />End call</Button>
          </>}
        </div>
        {audioBlocked && active && <Button variant="outline" className="min-h-12" onClick={() => void roomRef.current?.startAudio().catch(() => setError('Audio is blocked. Check your iPhone output and try again.'))}><Volume2 className="size-4" />Enable {name}’s audio</Button>}
        {!active && snapshot?.call && <Button variant="outline" className="min-h-11" onClick={() => void voiceRequest(`/calls/${snapshot.call!.id}/end`, {}).then(refresh).catch(e => setError(e.message))}>End previous call{snapshot.call.botName ? ` with ${snapshot.call.botName}` : ''}</Button>}
        <p className="text-pretty text-base text-muted-foreground sm:text-sm">Connect your AirPods before calling; choose the audio output in iPhone Control Center. Keep Veneer open during the call. Locking the phone or switching apps can interrupt it.</p>
        <p className="text-pretty text-base text-muted-foreground sm:text-sm">Standby disconnects audio and stops the microphone. Saved conversation and decisions remain here. Calls end after 55 minutes; tap to continue.</p>
      </section>
      {focused && <section className="flex flex-col gap-3 rounded-2xl border p-5" aria-label="Decision on this call">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">On this call · {decisionLabel(focused.state)}</p>
        <h2 className="text-balance text-xl font-semibold">{focused.question}</h2>
        <p className="text-base text-muted-foreground sm:text-sm">{focused.recommendation}</p>
        <p className="text-base font-medium sm:text-sm">{focused.consequence}</p>
        {onNavigate && <button className="self-start text-sm underline underline-offset-4" onClick={() => { end(); onNavigate(`#/bots/${focused.decisionId}`); }}>Open the full decision</button>}
      </section>}
      {bot && <section className="flex flex-col gap-4">
        <h2 className="text-balance text-xl font-semibold">Waiting on you · {open.length + (snapshot?.blockers.length ?? 0)}</h2>
        {open.length === 0 && snapshot?.blockers.length === 0 && <p className="text-base text-muted-foreground sm:text-sm">{bot.name} has nothing waiting on you. You can still ask what it is doing or tell it what to do next.</p>}
        {open.map(d => <article key={d.decisionId} className="flex flex-col gap-1 border-t pt-4">
          <h3 className="font-medium">{d.question}</h3>
          <p className="text-pretty text-base text-muted-foreground sm:text-sm">{d.recommendation}</p>
        </article>)}
        {snapshot?.blockers.map(blocker => <article key={blocker.requestId} className="flex flex-col gap-2 border-t pt-4">
          {blocker.questions.map(q => <p key={q.id} className="text-pretty text-base sm:text-sm">{q.question}</p>)}
        </article>)}
        {onNavigate && <button className="self-start text-sm underline underline-offset-4" onClick={() => { end(); onNavigate(`#/chat/${bot.conversationId}?from=bots`); }}>Open {bot.name}’s chat</button>}
      </section>}
      {!botConversationId && <section className="flex flex-col gap-4">
        <h2 className="text-balance text-xl font-semibold">Waiting for you{snapshot ? ` · ${snapshot.blockers.length}` : ''}</h2>
        {snapshot?.blockers.length === 0 && <p className="text-base text-muted-foreground sm:text-sm">No structured questions are waiting. Henry can still review a selected chat with you.</p>}
        {snapshot?.blockers.map(blocker => <article key={blocker.requestId} className="flex flex-col gap-2 border-t pt-4">
          <h3 className="font-medium"><a href={`#/chat/${blocker.conversationId}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">{blocker.title ?? 'Untitled chat'}</a></h3>
          {blocker.questions.map(q => <p key={q.id} className="text-pretty text-base text-muted-foreground sm:text-sm">{q.question}</p>)}
        </article>)}
      </section>}
      {!!snapshot?.history.length && <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Saved conversation</h2>
        <p className="text-base text-muted-foreground sm:text-sm">Transcripts can mishear speech. Delivered decisions are marked below.</p>
        <ol role="list" className="flex flex-col gap-5">{snapshot.history.slice(-30).map(entry => <li key={entry.id} className="flex flex-col gap-1">
          <p className="text-base font-medium sm:text-sm">{entry.role === 'user' ? 'You' : entry.role === 'decision' ? 'Decision delivered' : name}</p>
          <p className="whitespace-pre-wrap break-words text-base text-muted-foreground sm:text-sm">{entry.text}</p>
        </li>)}</ol>
      </section>}
      <div ref={audioHost} className="hidden" />
    </main>
  </div>;
}
