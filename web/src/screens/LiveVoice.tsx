import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { ArrowLeft, Mic, MicOff, Phone, PhoneOff, Pause, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { voiceRequest, type VoiceSnapshot } from '../lib/liveVoice';

type State = 'ready' | 'connecting' | 'connected' | 'reconnecting' | 'standby' | 'ended';
export function LiveVoice({ onBack }: { onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot | null>(null);
  const [state, setState] = useState<State>('ready');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [contextId, setContextId] = useState('');
  const roomRef = useRef<Room | null>(null);
  const micRef = useRef<LocalAudioTrack | null>(null);
  const callId = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const audioHost = useRef<HTMLDivElement>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const refresh = useCallback(async () => {
    const next = await voiceRequest<VoiceSnapshot>();
    if (mounted.current) setSnapshot(next);
    return next;
  }, []);
  const end = useCallback((next: State = 'ended') => {
    generation.current++;
    const id = callId.current; callId.current = null;
    const room = roomRef.current; roomRef.current = null;
    room?.removeAllListeners();
    micRef.current?.stop(); micRef.current = null;
    void room?.disconnect();
    audioHost.current?.replaceChildren();
    void wakeLock.current?.release(); wakeLock.current = null;
    if (id) void voiceRequest(`/calls/${id}/end`, {}, true).catch(() => {});
    if (mounted.current) { setState(next); setMuted(false); setAudioBlocked(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(e => setError(e.message));
    const timer = window.setInterval(() => {
      const epoch = generation.current;
      void refresh().then(next => {
        if (epoch === generation.current && callId.current && (!next.call || next.call.state === 'failed')) {
          setError(next.call?.error ?? 'The call ended. Tap Call Henry to continue.'); end();
        }
      }).catch(() => {});
      if (callId.current) void voiceRequest(`/calls/${callId.current}/heartbeat`, {}).catch(() => {
        if (epoch !== generation.current) return;
        setError('Connection lost. Your saved conversation is still here.'); end();
      });
    }, 10_000);
    const pagehide = () => end();
    const visibility = () => {
      if (document.visibilityState === 'visible' && roomRef.current) {
        void roomRef.current.startAudio().catch(() => setAudioBlocked(true));
        if ('wakeLock' in navigator) void navigator.wakeLock.request('screen').then(lock => { wakeLock.current = lock; }).catch(() => {});
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
    const epoch = ++generation.current;
    setError(null); setState('connecting');
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    // These begin in the actual tap handler, before any network await (iOS).
    const audioReady = room.startAudio().catch(() => { if (mounted.current) setAudioBlocked(true); });
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
      const result = await voiceRequest<{ id: string; url: string; token: string }>('/calls', contextId ? { contextConversationId: contextId } : {});
      if (generation.current !== epoch) { void voiceRequest(`/calls/${result.id}/end`, {}); return; }
      callId.current = result.id;
      await room.connect(result.url, result.token);
      if (generation.current !== epoch) { await room.disconnect(); return; }
      await room.localParticipant.publishTrack(mic);
      if (generation.current !== epoch) return;
      setState('connected');
      if ('wakeLock' in navigator) void navigator.wakeLock.request('screen').then(lock => { wakeLock.current = lock; }).catch(() => {});
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
  const status = state === 'connected' ? muted ? 'Microphone muted' : snapshot?.call?.state === 'speaking' ? 'Henry is speaking' : snapshot?.call?.state === 'thinking' ? 'Henry is checking' : 'Listening' :
    state === 'standby' ? 'On standby · microphone off' : state === 'connecting' ? 'Connecting…' : state === 'reconnecting' ? 'Reconnecting…' : 'Ready when you are';
  return <div className="h-full overflow-y-auto px-4 py-6 sm:px-8">
    <main className="mx-auto flex max-w-3xl flex-col gap-8 pb-[env(safe-area-inset-bottom)]">
      <header className="flex flex-col gap-4">
        <Button variant="ghost" className="min-h-11 self-start" onClick={() => { end(); onBack(); }}><ArrowLeft className="size-4" /> Back</Button>
        <div className="flex flex-col gap-2"><h1 className="text-balance text-3xl font-semibold tracking-tight">Talk to Henry</h1>
          <p className="text-pretty text-base text-muted-foreground sm:text-sm">Work through questions together. Your decisions go back to the waiting agents.</p></div>
      </header>
      {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-base text-destructive sm:text-sm">{error}</p>}
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
        {!active && <div className="flex flex-col gap-2">
          <label htmlFor="voice-context" className="text-base sm:text-sm">Working context <span className="text-muted-foreground">(optional)</span></label>
          <select id="voice-context" value={contextId} onChange={e => setContextId(e.target.value)} className="min-h-11 w-full rounded-lg border bg-background px-3 text-base">
            <option value="">All my pending questions</option>
            {snapshot?.chats.map(chat => <option key={chat.id} value={chat.id}>{chat.projectName ? `${chat.projectName} · ` : ''}{chat.title ?? 'Untitled chat'}</option>)}
          </select>
        </div>}
        <div className="flex flex-wrap gap-3">
          {!active ? <Button className="min-h-12 flex-1" disabled={!snapshot?.configuration.ready} onClick={() => void start()}><Phone className="size-4" />{state === 'standby' ? 'Resume conversation' : 'Call Henry'}</Button> : <>
            <Button variant="outline" className="min-h-12 flex-1" disabled={state !== 'connected'} aria-pressed={muted} onClick={() => void toggleMute()}>{muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}{muted ? 'Unmute' : 'Mute'}</Button>
            <Button variant="outline" className="min-h-12 flex-1" onClick={() => end('standby')}><Pause className="size-4" />Standby</Button>
            <Button variant="destructive" className="min-h-12 flex-1" onClick={() => end()}><PhoneOff className="size-4" />End call</Button>
          </>}
        </div>
        {audioBlocked && active && <Button variant="outline" className="min-h-12" onClick={() => void roomRef.current?.startAudio().catch(() => setError('Audio is blocked. Check your iPhone output and try again.'))}><Volume2 className="size-4" />Enable Henry’s audio</Button>}
        {!active && snapshot?.call && <Button variant="outline" className="min-h-11" onClick={() => void voiceRequest(`/calls/${snapshot.call!.id}/end`, {}).then(refresh).catch(e => setError(e.message))}>End previous call</Button>}
        <p className="text-pretty text-base text-muted-foreground sm:text-sm">Connect your AirPods before calling; choose the audio output in iPhone Control Center. Keep Veneer open for this trial. Locking the phone or switching apps can interrupt the call.</p>
        <p className="text-pretty text-base text-muted-foreground sm:text-sm">Standby disconnects audio and stops the microphone. Saved conversation and decisions remain here. Calls end after 55 minutes; tap to continue.</p>
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-balance text-xl font-semibold">Waiting for you{snapshot ? ` · ${snapshot.blockers.length}` : ''}</h2>
        {snapshot?.blockers.length === 0 && <p className="text-base text-muted-foreground sm:text-sm">No structured questions are waiting. Henry can still review a selected chat with you.</p>}
        {snapshot?.blockers.map(blocker => <article key={blocker.requestId} className="flex flex-col gap-2 border-t pt-4">
          <h3 className="font-medium"><a href={`#/chat/${blocker.conversationId}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">{blocker.title ?? 'Untitled chat'}</a></h3>
          {blocker.questions.map(q => <p key={q.id} className="text-pretty text-base text-muted-foreground sm:text-sm">{q.question}</p>)}
        </article>)}
      </section>
      {!!snapshot?.history.length && <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Saved conversation</h2>
        <p className="text-base text-muted-foreground sm:text-sm">Transcripts can mishear speech. Delivered decisions are marked below.</p>
        <ol role="list" className="flex flex-col gap-5">{snapshot.history.slice(-30).map(entry => <li key={entry.id} className="flex flex-col gap-1">
          <p className="text-base font-medium sm:text-sm">{entry.role === 'user' ? 'You' : entry.role === 'decision' ? 'Decision delivered' : 'Henry'}</p>
          <p className="whitespace-pre-wrap break-words text-base text-muted-foreground sm:text-sm">{entry.text}</p>
        </li>)}</ol>
      </section>}
      <div ref={audioHost} className="hidden" />
    </main>
  </div>;
}
