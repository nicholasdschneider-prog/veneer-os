import { useEffect, useRef, useState } from 'react';
import { requestJson } from '@/lib/api';
import { TeachingRecorder, type RecordedNarration } from '@/lib/teachingRecorder';
import { Button } from './ui/button';
const base = '/api/bot-workflows';
const field = 'min-w-0 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm';
const json = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Act = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
export interface Teaching {
    id: string;
    name: string;
    state: string;
    steps_json: string;
    draft: string;
    started_at: string;
    expires_at: string;
    skill_name: string | null;
    test_requested_at: string | null;
}
interface Clip {
    id: string;
    offset_ms: number;
    duration_ms: number;
    transcript: string | null;
}
export function Teach({ bot, session, busy, act, reload, className, }: {
    bot: {
        id: string;
        name: string;
    };
    session: Teaching | null;
    busy: boolean;
    act: Act;
    reload: () => Promise<void>;
    className?: string;
}) {
    const [narrate, setNarrate] = useState(false), [mic, setMic] = useState(false), [audioBusy, setAudioBusy] = useState(false), [audioError, setAudioError] = useState(''), [clips, setClips] = useState<Clip[]>([]), [pending, setPending] = useState<RecordedNarration[]>([]);
    const recorder = useRef<TeachingRecorder | null>(null), mounted = useRef(true), target = useRef<string | null>(null);
    const loadClips = async (id: string) => { const r = await requestJson<{
        clips: Clip[];
    }>(`${base}/teaching/${id}/audio`); if (mounted.current && target.current === id)
        setClips(r.clips); };
    const upload = async (id: string, c: RecordedNarration) => {
        if (mounted.current)
            setAudioBusy(true);
        try {
            const saved = await requestJson<{
                id: string;
            }>(`${base}/teaching/${id}/audio?${new URLSearchParams({ key: c.key, offset: String(c.offset), duration: String(c.duration) })}`, { method: 'POST', headers: { 'Content-Type': c.blob.type }, body: c.blob });
            if (mounted.current)
                setPending(p => p.filter(x => x.key !== c.key));
            await loadClips(id);
            await requestJson(`${base}/teaching/${id}/audio/${saved.id}/transcribe`, json('POST'));
        }
        catch (e) {
            if (mounted.current)
                setAudioError((e as Error).message);
        }
        finally {
            if (mounted.current) {
                setAudioBusy(false);
                void loadClips(id).catch(e => setAudioError(e.message));
            }
        }
    };
    const begin = async (t: Teaching) => {
        if (mic || audioBusy)
            return;
        setAudioBusy(true);
        setAudioError('');
        const r = new TeachingRecorder(Date.parse(t.started_at), async (c) => { if (mounted.current)
            setPending(p => [...p, c]); await upload(t.id, c); }, () => { if (mounted.current)
            setMic(false); });
        recorder.current = r;
        try {
            await r.start();
            if (mounted.current)
                setMic(true);
        }
        catch (e) {
            if (mounted.current)
                setAudioError(`Microphone unavailable: ${(e as Error).message} Browser actions are still recorded. Retry or continue without narration.`);
        }
        finally {
            if (mounted.current)
                setAudioBusy(false);
        }
    };
    useEffect(() => { target.current = session?.id ?? null; if (session)
        void loadClips(session.id).catch(e => setAudioError(e.message));
    else
        setClips([]); }, [session?.id]);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; void recorder.current?.stop(); if (target.current)
        void requestJson(`${base}/teaching/${target.current}/pause`, json('POST')).catch(() => { }); }; }, []);
    useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (mic || pending.length || audioBusy) {
        e.preventDefault();
    } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [mic, pending.length, audioBusy]);
    useEffect(() => { window.dispatchEvent(new CustomEvent('veneer:teaching-capture', { detail: mic || audioBusy || pending.length > 0 })); return () => { window.dispatchEvent(new CustomEvent('veneer:teaching-capture', { detail: false })); }; }, [mic, audioBusy, pending.length]);
    const [name, setName] = useState(''), [outcome, setOutcome] = useState(''), [draft, setDraft] = useState(''), [skill, setSkill] = useState(''), [example, setExample] = useState(''), [clock, setClock] = useState(Date.now());
    useEffect(() => {
        setDraft(session?.draft ?? '');
        setSkill(session?.skill_name ??
            session?.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') ??
            '');
    }, [session?.id, session?.draft, session?.skill_name]);
    const active = !!session && ['recording', 'paused'].includes(session.state);
    useEffect(() => {
        if (!active)
            return;
        const timer = setInterval(() => {
            setClock(Date.now());
            void reload().catch(e => setAudioError(e.message));
        }, 2000);
        return () => clearInterval(timer);
    }, [active, reload]);
    const action = (a: string, body?: unknown) => act(async () => {
        if (a === 'pause' || a === 'stop' || a === 'discard') {
            const stopped = recorder.current?.stop();
            if (session && ['recording', 'paused'].includes(session.state) && Date.now() < Date.parse(session.expires_at))
                await requestJson(`${base}/teaching/${session.id}/pause`, json('POST'));
            await stopped;
        }
        await requestJson(`${base}/teaching/${session!.id}/${a}`, json('POST', body));
        if (a === 'resume' && narrate)
            await begin(session!);
        if (a === 'discard') {
            setClips([]);
            setPending([]);
            setAudioError('');
        }
    }, a === 'save'
        ? 'Skill saved. Test it on a second example before scheduling.'
        : 'Updated');
    return (<div className={`min-w-0 space-y-4 ${className ?? ''}`}>
      <p className="text-sm text-muted-foreground">
        Demonstrate one workflow in the browser below. Recording lasts up to 10
        minutes. Browser actions are captured, not a screen video. Optionally record your microphone to explain what you do and why. Typed values and passwords are excluded from browser actions. Pause before signing in or speaking private information; audio records what you say.
      </p>
      {!session || session.state === 'saved' ? (<form className="space-y-3" onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                    const r = await requestJson<{
                        session: Teaching;
                    }>(`${base}/bots/${bot.id}/teach`, json('POST', { name, outcome }));
                    target.current = r.session.id;
                    if (narrate)
                        await begin(r.session);
                }, 'Recording started');
            }}>
          <label className="block text-sm">
            Task name
            <input required className={field} value={name} onChange={(e) => setName(e.target.value)}/>
          </label>
          <label className="block text-sm">
            Expected outcome
            <textarea required rows={2} className={field} value={outcome} onChange={(e) => setOutcome(e.target.value)}/>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={narrate} onChange={e => setNarrate(e.target.checked)}/>Record microphone narration</label>
          <p className="text-xs text-muted-foreground">Microphone only, no tab or system audio. Saved clips are sent to the configured voice transcription service. Review the transcript before saving the skill.</p>
          <Button disabled={busy}>Start demonstration</Button>
        </form>) : null}
      {audioError && <p role="alert" className="text-sm text-destructive">{audioError}</p>}
      {mic && <p className="text-xs text-muted-foreground">Stop or pause narration and wait for audio to save before closing settings.</p>}
      {audioBusy && <p role="status" className="text-sm">Saving and transcribing narration…</p>}
      {pending.length > 0 && <div className="space-y-2">{pending.map(c => <Button key={c.key} variant="outline" disabled={audioBusy} onClick={() => void upload(session!.id, c)}>Retry saving audio clip</Button>)}<p className="text-xs">Keep this tab open until audio is saved.</p></div>}
      {active && (<>
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="text-sm">{mic ? '● Microphone recording' : 'Microphone off'}</span>
            {!mic && session.state === 'recording' && clock < Date.parse(session.expires_at) && <Button variant="outline" disabled={busy || audioBusy} onClick={() => { setNarrate(true); void begin(session); }}>Enable microphone</Button>}
            {audioError && <Button variant="ghost" onClick={() => { setNarrate(false); setAudioError(''); }}>Continue without narration</Button>}
            <span role="status" className="text-sm font-medium">
              {clock >= Date.parse(session.expires_at)
                ? 'Time limit reached'
                : session.state === 'recording'
                    ? 'Recording'
                    : 'Paused'}{' '}
              ·{' '}
              {Math.max(0, Math.ceil((Date.parse(session.expires_at) - clock) / 1000))}
              s remaining · {JSON.parse(session.steps_json).length} actions
            </span>
            <Button variant="outline" disabled={busy || audioBusy || clock >= Date.parse(session.expires_at)} onClick={() => void action(session.state === 'paused' ? 'resume' : 'pause')}>
              {session.state === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button disabled={busy || audioBusy} onClick={() => void action('stop')}>
              Stop and review
            </Button>
          </div>
          <iframe title={`${bot.name} teaching browser`} src={`/veneer-browser?conversation=${bot.id}&chrome=off`} className="h-[55dvh] w-full rounded-lg border"/>
        </>)}
      {clips.length > 0 && <section className="space-y-3 rounded-xl border p-3" aria-label="Recorded narration">
        <h3 className="font-medium">Recorded narration</h3>
        <p className="text-xs text-muted-foreground">Clip times match the browser action timeline. Your selected bot receives the reviewed transcript in the saved skill, not an unexamined audio attachment.</p>
        {clips.map(c => <NarrationClip key={c.id} clip={c} session={session!} busy={audioBusy || busy} onChange={() => void loadClips(session!.id)} onError={setAudioError}/>)}
        {session?.state === 'draft' && <p className="text-xs text-muted-foreground">Updating the draft rebuilds its steps and narration; copy any unsaved manual edits first.</p>}
        {session?.state === 'draft' && <Button variant="outline" disabled={audioBusy || busy || pending.length > 0} onClick={() => void action('stop')}>Update draft from transcript</Button>}
      </section>}
      {session?.state === 'draft' && (<>
          <label className="block text-sm">
            Skill name
            <input className={field} value={skill} onChange={(e) => setSkill(e.target.value)}/>
          </label>
          <label className="block text-sm">
            Review the skill
            <textarea className={`${field} font-mono`} rows={15} value={draft} onChange={(e) => setDraft(e.target.value)}/>
          </label>
          <Button disabled={busy || audioBusy || pending.length > 0 || clips.some(c => c.transcript === null) || !draft || !skill} onClick={() => void action('save', { skillName: skill, draft })}>
            Save reviewed skill
          </Button>
        </>)}
      {session?.state === 'saved' && (<div className="space-y-2 rounded-xl border p-3">
          <p className="font-medium">Saved: {session.skill_name}</p>
          <label className="block text-sm">
            Second example and expected result
            <textarea className={field} value={example} onChange={(e) => setExample(e.target.value)}/>
          </label>
          <Button disabled={busy || !example.trim()} onClick={() => void action('test', { example })}>
            Ask {bot.name} to test
          </Button>
          {session.test_requested_at && (<a className="block text-sm underline" href={`#/chat/${bot.id}`}>
              Review the test in the bot conversation
            </a>)}
        </div>)}
      {session && session.state !== 'saved' && (<Button variant="ghost" disabled={busy || audioBusy} onClick={() => void action('discard')}>
          Discard demonstration
        </Button>)}
    </div>);
}
function NarrationClip({ clip, session, busy, onChange, onError }: {
    clip: Clip;
    session: Teaching;
    busy: boolean;
    onChange: () => void;
    onError: (s: string) => void;
}) {
    const [text, setText] = useState(clip.transcript ?? ''), [working, setWorking] = useState(false);
    useEffect(() => setText(clip.transcript ?? ''), [clip.transcript]);
    const apply = async (action: string, method = 'POST', body?: unknown) => { setWorking(true); try {
        await requestJson(`${base}/teaching/${session.id}/audio/${clip.id}${action}`, json(method, body));
        onChange();
    }
    catch (e) {
        onError((e as Error).message);
    }
    finally {
        setWorking(false);
    } };
    return <div className="min-w-0 space-y-2 border-t pt-3">
   <p className="text-sm">{(clip.offset_ms / 1000).toFixed(1)}s · {(clip.duration_ms / 1000).toFixed(1)} seconds</p>
   <audio controls preload="none" className="w-full" aria-label={`Narration at ${(clip.offset_ms / 1000).toFixed(1)} seconds`} src={`${base}/teaching/${session.id}/audio/${clip.id}`}/>
   <label className="block text-sm">Transcript<textarea rows={3} className={field} value={text} readOnly={session.state === 'saved'} onChange={e => setText(e.target.value)}/></label>
   {clip.transcript === null && <p className="text-xs">Transcript not available yet. Retry transcription or enter what you said.</p>}
   {session.state !== 'saved' && <div className="flex flex-wrap gap-2">
     {clip.transcript === null && <Button variant="outline" disabled={busy || working} onClick={() => void apply('/transcribe')}>Retry transcription</Button>}
     <Button variant="outline" disabled={busy || working} onClick={() => void apply('/transcript', 'PUT', { text })}>Save transcript</Button>
     <Button variant="ghost" disabled={busy || working} onClick={() => void apply('', 'DELETE')}>Remove clip</Button>
   </div>}
 </div>;
}
