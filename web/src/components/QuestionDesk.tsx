import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Hand, List, ChevronDown, Phone, PhoneIncoming, Clock, MessageSquare } from 'lucide-react';
import { ApiError, requestJson } from '@/lib/api';
import type { BotDecision } from '@/lib/bots';
import { BotAvatar } from './BotIdentity';
import { Button } from './ui/button';
import { Bots } from '@/screens/Bots';
import { useLiveVoice } from './VoiceProvider';
import { SideChatPanel } from './chat/SideChatPanel';
import { Chat } from '@/screens/Chat';
import { DeskPill } from './DeskPill';
import { BotCallRing, BotCallSettings } from './BotCalls';
import { DESK_DOCKED_QUERY, DeskSheetContext, deskSheetStyle } from '@/lib/chatViewport';
import { isTextEntryFocused } from '@/hooks/useDocumentScrollLock';
import { useMediaQuery } from '@/hooks/useMediaQuery';

type Side = { parentId: string; agentName: string; sideParam: string };
type Chief = { conversation_id: string; name: string | null; active: boolean };
type Line = { decisions: BotDecision[]; sleeping: (BotDecision & { until: number })[]; selectedId: string | null; revision: number; showEvidence?: boolean };
const DeskContext = createContext<{ adoptQuestion: (id?: string) => void; adoptSide: (side: Side) => void; available: boolean }>({ adoptQuestion: () => {}, adoptSide: () => {}, available: false });
export const useQuestionDesk = () => useContext(DeskContext);
const empty: Line = { decisions: [], sleeping: [], selectedId: null, revision: 0 };
const navigate = (hash: string) => { window.location.hash = hash; };

/** The desk itself: a full-screen sheet on phones and tablets that shrinks to
 * the visual viewport while a field inside it has the keyboard, and a docked
 * column on desktop. Holds its own viewport state so a keyboard resize never
 * re-renders the chats inside it. */
function DeskSheet({ open, children }: { open: boolean; children: ReactNode }) {
  const sheet = !useMediaQuery(DESK_DOCKED_QUERY);
  const ref = useRef<HTMLElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();
  useLayoutEffect(() => {
    if (!sheet || !open) { setStyle(undefined); return; }
    const vv = window.visualViewport;
    const update = () => {
      const active = document.activeElement;
      const typing = !!active && !!ref.current?.contains(active) && isTextEntryFocused(active as HTMLElement);
      const next = deskSheetStyle(sheet, typing, vv);
      setStyle(prev => prev?.top === next?.top && prev?.left === next?.left && prev?.width === next?.width && prev?.height === next?.height ? prev : next);
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [sheet, open]);
  return <DeskSheetContext.Provider value={sheet}>
    <aside ref={ref} aria-label="Question desk" style={style} className={open ? 'question-desk flex min-h-0 flex-col border-l bg-background fixed inset-0 z-40 h-dvh pt-[env(safe-area-inset-top)] lg:static lg:h-dvh lg:w-[min(30rem,42vw)] lg:shrink-0 lg:pt-0' : 'hidden'}>{children}</aside>
  </DeskSheetContext.Provider>;
}

/** Lives above routing: the active question, conversation and composer never follow navigation. */
export function QuestionDesk({ children }: { children: ReactNode }) {
  const [line, setLine] = useState<Line>(empty);
  const [visited,setVisited]=useState<string[]>([]);
  const [mode, setMode] = useState<'question'|'side'|'chief'|null>(null);
  // The owner's chief of staff bot: always reachable from the pill, and its
  // chat stays mounted once opened so a half-written message survives.
  const [chief, setChief] = useState<{ id: string; name: string } | null>(null);
  const [chiefOpened, setChiefOpened] = useState(false);
  const [side, setSide] = useState<Side | null>(null);
  const [list, setList] = useState(false);
  const [later, setLater] = useState(false);
  const [calls, setCalls] = useState(false);
  const [until, setUntil] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const voice = useLiveVoice();
  const current = useRef(line); current.current = line;
  const serial = useRef(0);
  const pending = useRef(false);
  const refreshing=useRef(false);
  const alive = useRef(true);
  const selected = line.decisions.find(d => d.id === line.selectedId);
  const front = selected ?? line.decisions[0];
  useEffect(()=>{
    const accessible=new Set([...line.decisions,...line.sleeping].map(d=>d.id));
    setVisited(prev=>{
      const next=prev.filter(id=>accessible.has(id));
      if(line.selectedId&&!next.includes(line.selectedId))next.push(line.selectedId);
      return next.length===prev.length&&next.every((id,i)=>id===prev[i])?prev:next;
    });
  },[line]);
  const refresh = async () => {
    if (pending.current || refreshing.current) return;
    refreshing.current=true;
    const controller=new AbortController();
    const timeout=window.setTimeout(()=>controller.abort(),15000);
    const seq = ++serial.current;
    try {
      const next = await requestJson<Line>('/api/question-line',{signal:controller.signal});
      if (!alive.current || seq !== serial.current) return;
      if (current.current.selectedId && !next.selectedId) setNotice('This question has left your line. Select the next one when you’re ready.');
      setLine(next); setLoaded(true); setError('');
    } catch(e) {
      if(alive.current && seq===serial.current) {
        if(e instanceof ApiError && [401,403].includes(e.status)) { setLine(empty);setSide(null);setMode(null);setUserId(null);setChief(null); }
        setError('Questions could not refresh. Reconnect before answering.');setLoaded(true);
      }
    } finally {refreshing.current=false;clearTimeout(timeout);}
  };
  useEffect(() => {
    alive.current = true;
    void requestJson<{user:{id:number}|null}>('/api/me').then(r => { if (alive.current) setUserId(r.user?.id ?? null); }).catch(() => {});
    const loadChief = () => void requestJson<{chief_of_staff:Chief|null}>('/api/bots/chief-of-staff')
      .then(r => { if (alive.current) setChief(r.chief_of_staff?.active ? { id: r.chief_of_staff.conversation_id, name: r.chief_of_staff.name ?? 'Chief of staff' } : null); })
      .catch(() => { if (alive.current) setChief(null); });
    loadChief();
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
    const wake = () => { void refresh(); loadChief(); };
    window.addEventListener('focus',wake); window.addEventListener('chat-decisions-changed',wake);
    return () => { alive.current = false; ++serial.current; clearInterval(timer); window.removeEventListener('focus',wake); window.removeEventListener('chat-decisions-changed',wake); };
  }, []);
  useEffect(() => {
    if (!line.showEvidence || !line.selectedId) return;
    setMode('question'); setList(false);
    const timer=window.setTimeout(()=>document.querySelector(`[data-question-id="${CSS.escape(line.selectedId!)}"] [data-question-evidence]`)?.scrollIntoView({block:'start'}),500);
    return ()=>clearTimeout(timer);
  }, [line.revision,line.showEvidence,line.selectedId]);
  const act = async (action: string, decisionId?: string, reminder?: number) => {
    if (pending.current) return;
    pending.current = true; ++serial.current; setBusy(true); setError('');
    try {
      const next = await requestJson<Line>('/api/question-line',{method:'POST',body:JSON.stringify({action,decisionId,until:reminder,revision:current.current.revision})});
      setLine(next); setLater(false); setList(false);
      if (action === 'select') { setMode('question'); setNotice(''); }
      else { setMode(null); setNotice(action === 'remind' ? 'Reminder saved. The question will rejoin your line at that time.' : 'Moved to the back of the line.'); }
    } catch(e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  };
  const actionRef=useRef(act);actionRef.current=act;
  const adoptQuestion=useRef((id?:string)=>{setMode('question');setList(!id);if(id)void actionRef.current('select',id);}).current;
  const adoptSide = useRef((next: Side) => { setSide(next); setMode('side'); }).current;
  const total = line.decisions.length;
  const openChief = () => { setChiefOpened(true); setMode('chief'); };
  return <DeskContext.Provider value={{adoptSide,adoptQuestion,available:true}}>
    <div className="question-desktop-shell flex h-dvh min-w-0 isolate overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      <DeskSheet open={!!mode}>
        <header className="flex shrink-0 items-center gap-2 border-b p-2">
          <Button type="button" variant="ghost" aria-pressed={mode === 'question'} onClick={() => setMode('question')}><Hand className="size-4 shrink-0" /> Questions</Button>
          {chief && <Button type="button" variant="ghost" aria-pressed={mode === 'chief'} onClick={openChief}><MessageSquare className="size-4 shrink-0" /> {chief.name}</Button>}
          {side && <Button type="button" variant="ghost" aria-pressed={mode === 'side'} onClick={() => setMode('side')}><MessageSquare className="size-4 shrink-0" /> Side chat</Button>}
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="icon" aria-label="Collapse question desk" onClick={() => setMode(null)}><ChevronDown className="size-4" /></Button>
        </header>
        <div className={mode === 'question' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <div className="flex flex-wrap items-center gap-2 border-b p-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setList(!list)}><List className="size-4" /> {total} waiting</Button>
            <Button type="button" variant="outline" disabled={!!voice.pinnedId || !total} onClick={() => {setList(false);voice.hotline();}}><Phone className="size-4" /> Hotline</Button>
            <Button type="button" variant="ghost" aria-expanded={calls} onClick={() => setCalls(!calls)}><PhoneIncoming className="size-4" /> Calls</Button>
            {selected && <><Button type="button" variant="ghost" onClick={()=>document.querySelector(`[data-question-id="${CSS.escape(selected.id)}"] [id=decision-composer]`)?.scrollIntoView({block:'end'})}>Chat</Button><Button type="button" variant="ghost" disabled={busy || !!voice.pinnedId} onClick={() => voice.open(selected.conversation_id,selected.id)}>Call {selected.bot_name}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setLater(!later)}><Clock className="size-4" /> Later</Button></>}
          </div>
          {calls && <BotCallSettings />}
          {error && <p role="alert" className="p-3 text-sm text-destructive">{error}</p>}
          {notice && <p role="status" className="p-3 text-sm text-muted-foreground">{notice}</p>}
          {later && selected && <div className="space-y-3 border-b p-3">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void act('back',selected.id)}>Send to back</Button>
            <label className="block text-sm">Remind me at<input type="datetime-local" name="question-reminder" value={until} onChange={e=>setUntil(e.target.value)} className="mt-2 block min-h-11 w-full rounded-md border bg-background px-3 text-base" /></label>
            <Button type="button" variant="outline" disabled={busy || !until || !Number.isFinite(Date.parse(until))} onClick={() => void act('remind',selected.id,Date.parse(until))}>Save reminder</Button>
            <p className="text-sm text-muted-foreground">Returns to your line at this time, in your local timezone. No answer is recorded.</p>
          </div>}
          {(list || !selected) && <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {!total && <p className="text-base text-muted-foreground sm:text-sm">{loaded ? 'No questions waiting right now.' : 'Loading your questions…'}</p>}
            {line.decisions.map(d => <button type="button" key={d.id} disabled={busy || !!error} onClick={() => void act('select',d.id)} className="flex min-h-12 w-full items-start gap-3 rounded-xl border p-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><BotAvatar id={d.conversation_id} name={d.bot_name}/><div className="min-w-0"><p className="text-sm font-medium">{d.bot_name}</p><p className="text-base sm:text-sm">{d.proposal.review_summary?.request || d.proposal.question}</p>{d.stale && <p className="text-sm text-muted-foreground">Awaiting updated facts</p>}</div></button>)}
            {line.sleeping.length > 0 && <details><summary className="min-h-11 cursor-pointer py-3 text-sm">{line.sleeping.length} reminders</summary>{line.sleeping.map(d=><button type="button" key={d.id} className="block w-full border-t p-3 text-left text-sm" disabled={busy} onClick={()=>void act('select',d.id)}>{d.bot_name}: {d.proposal.question}<p className="text-muted-foreground">{new Date(d.until).toLocaleString()}</p></button>)}</details>}
          </div>}
          {visited.map(id=><div key={`${userId}:${id}`} data-question-id={id} className={!list && selected?.id===id ? 'min-h-0 flex-1' : 'hidden'}><Bots embedded desk active={mode==='question' && selected?.id===id && !list} decisionId={id} onNavigate={hash => { if (hash === '#/bots') setList(true); else navigate(hash); }} /></div>)}
        </div>
        {chief && chiefOpened && <div className={mode === 'chief' ? 'min-h-0 flex-1' : 'hidden'}>
          <Chat key={chief.id} conversationId={chief.id} artifacts={[]} onOpenArtifact={() => undefined} onRefreshArtifacts={async () => []} onPublishArtifact={async () => undefined} onOpenCitations={() => undefined} onOpenProjectFile={() => undefined} onNavigate={navigate} onToast={setNotice} sideChatButton={false} openQuestionsButton={false} />
        </div>}
        {side && <div className={mode === 'side' ? 'min-h-0 flex-1' : 'hidden'}><SideChatPanel key={`${side.parentId}:${side.sideParam}`} {...side} onSelect={value=>setSide(current=>current ? {...current,sideParam:value} : null)} onNavigate={navigate} onToast={setNotice} onClose={()=>setMode(null)} /></div>}
      </DeskSheet>
    </div>
    <BotCallRing enabled={userId !== null} />
    {!mode && (chief || (loaded && (total > 0 || line.sleeping.length > 0 || side || (userId && error)))) && <DeskPill
      front={front ? { id: front.conversation_id, name: front.bot_name } : null}
      total={total}
      error={Boolean(error)}
      chief={chief}
      onOpenQuestions={() => { setMode('question'); if (front && !selected) void act('select',front.id); }}
      onOpenList={() => { setMode('question'); setList(true); }}
      onOpenChief={openChief}
    />}
  </DeskContext.Provider>;
}
