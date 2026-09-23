import { useState } from 'react';
import { MessageSquare, Mic, MicOff, Phone, Settings2, X } from 'lucide-react';
import { BotAvatar } from './BotIdentity';
import type { VoiceSnapshot } from '@/lib/liveVoice';

export function VoiceCallPanel({ name, botId, status, active, connected, muted, level, history, ready, onStart, onMute, onEnd, onStandby, children }: {
  name: string; botId: string; status: string; active: boolean; connected: boolean; muted: boolean;
  level: number; history: VoiceSnapshot['history']; ready: boolean;
  onStart: () => void; onMute: () => void; onEnd: () => void; onStandby: () => void; children?: React.ReactNode;
}) {
  const [transcript, setTranscript] = useState(false);
  const [settings, setSettings] = useState(false);
  const circle = 'flex size-12 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40';
  return <section aria-label={`Live voice · ${name}`} className="flex max-h-[75dvh] flex-col overflow-hidden rounded-[2rem] border bg-background p-3 shadow-xl">
    <div className="flex items-center justify-between gap-3 rounded-full bg-muted p-2">
      <BotAvatar id={botId} name={name} />
      <div aria-hidden="true" className="flex h-10 flex-1 items-center justify-center gap-1">
        {[.3,.6,.85,.5,1,.7,.4,.9,.55].map((weight, index) => <span key={index} className="w-1 rounded-full bg-foreground transition-[height] duration-150 motion-reduce:transition-none" style={{height: `${3 + Math.min(1, Math.max(0, level)) * weight * 29}px`}} />)}
      </div>
      <span aria-label="You" className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium">You</span>
    </div>
    <p role="status" className="mt-2 text-center text-xs text-muted-foreground">{status}</p>
    {!active && <button type="button" disabled={!ready} onClick={onStart} className="mt-3 flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 text-primary-foreground disabled:opacity-40"><Phone className="size-4" />Start voice</button>}
    <div className="mt-3 flex justify-center gap-3">
      <button type="button" aria-label="Voice settings" aria-expanded={settings} onClick={() => setSettings(!settings)} className={`${circle} bg-muted text-foreground hover:bg-accent`}><Settings2 className="size-5" /></button>
      <button type="button" aria-label="Show transcript" aria-expanded={transcript} aria-pressed={transcript} onClick={() => setTranscript(!transcript)} className={`${circle} ${transcript ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-muted text-foreground hover:bg-accent'}`}><MessageSquare className="size-5" /></button>
      <button type="button" aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={muted} disabled={!connected} onClick={onMute} className={`${circle} bg-muted text-foreground hover:bg-accent`}>{muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}</button>
      <button type="button" aria-label="Close and end voice" onClick={onEnd} className={`${circle} bg-destructive text-white hover:opacity-90`}><X className="size-5" /></button>
    </div>
    <div className="min-h-0 overflow-y-auto overscroll-contain">
      {children}
      {settings && <div className="mt-3 space-y-3 rounded-xl bg-muted p-3 text-sm"><p>Keep Veneer open. Choose AirPods or speaker output using your device’s audio controls.</p><a className="block underline" href={`#/chat/${botId}`}>Open pinned conversation</a>{active && <button type="button" onClick={onStandby} className="min-h-11 w-full rounded-lg border bg-background px-3">Standby · microphone off</button>}</div>}
      {transcript && <ol aria-label="Saved voice conversation" className="mt-4 flex flex-col gap-4 px-2 pb-2 text-sm">
        {history.length === 0 && <li className="text-center text-muted-foreground">Your saved transcript will appear here.</li>}
        {history.map(entry => <li key={entry.id} className={entry.role === 'user' ? 'ml-5 text-right text-muted-foreground' : 'mr-5 text-foreground'}><span className="sr-only">{entry.role === 'user' ? 'You' : entry.role === 'decision' ? 'Decision delivered' : name}: </span><p className="whitespace-pre-wrap break-words">{entry.text}</p></li>)}
      </ol>}
    </div>
    <button type="button" aria-label={transcript ? 'Collapse transcript' : 'Expand transcript'} onClick={() => setTranscript(!transcript)} className="flex min-h-8 shrink-0 items-end justify-center pb-1"><span className="h-1 w-10 rounded-full bg-muted-foreground/40" /></button>
  </section>;
}
