import { useEffect, useState } from 'react';
import { requestJson } from '@/lib/api';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

type Policy={enabled:boolean};
type Calendar={enabled:boolean;ready:boolean;blockers:string[];prepared:{manifest_hash:string;manifest:{bindings:{account:string;calendarIds:string[]}[]}}|null};
export function ArcherCallSettings({phoneEnabled,botEnabled}:{phoneEnabled:boolean;botEnabled:boolean}) {
  const [policy,setPolicy]=useState<Policy|null>(null);const [calendar,setCalendar]=useState<Calendar|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const refresh=async()=>{
    const [p,c]=await Promise.all([requestJson<Policy>('/api/bot-calls/outbound-policy'),requestJson<Calendar>('/api/calendar-phone-reminders/settings')]);
    setPolicy(p);setCalendar(c);
  };
  useEffect(()=>{let alive=true;void Promise.all([requestJson<Policy>('/api/bot-calls/outbound-policy'),requestJson<Calendar>('/api/calendar-phone-reminders/settings')]).then(([p,c])=>{if(alive){setPolicy(p);setCalendar(c);}}).catch(e=>{if(alive)setError((e as Error).message);});return()=>{alive=false;};},[]);
  const change=async(path:string,body:unknown)=>{setBusy(true);setError('');try{await requestJson(path,{method:'POST',body:JSON.stringify(body)});await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="space-y-3 rounded-xl border p-3" aria-label="Archer phone calls">
    {error&&<p role="alert" className="text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-3"><div><p className="font-medium">Archer can call about his work</p><p className="text-muted-foreground">On your phone, with his usual voice. You can interrupt, change topics, ask questions, and give him new instructions.</p></div>
      <Switch checked={policy?.enabled??false} disabled={busy||!policy} aria-label="Archer can call about his work" onCheckedChange={()=>void change('/api/bot-calls/outbound-policy',{enabled:!policy?.enabled})}/></div>
    {(!phoneEnabled||!botEnabled)&&<p className="text-muted-foreground">Turn on Call my phone and Archer under Bots that can call me to use these calls.</p>}
    <p className="font-medium">Calendar reminders</p><p className="text-muted-foreground">Archer calls 20 minutes before timed meetings on your three Google accounts, even while you’re using Veneer and outside ordinary calling hours. Do not disturb still pauses calls. Missed meeting reminders aren’t redialed.</p>
    {!calendar?.prepared&&<Button type="button" variant="outline" disabled={busy||!policy} onClick={()=>void change('/api/calendar-phone-reminders/prepare-from-connectors',{})}>Prepare my connected calendars</Button>}
    {calendar?.prepared&&<>
      {calendar.prepared.manifest.bindings.map(b=><p key={b.account} className="break-all text-muted-foreground">{b.account} · {b.calendarIds.length} calendar{b.calendarIds.length===1?'':'s'}</p>)}
      <details><summary className="cursor-pointer">Review calendar setup</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(calendar.prepared,null,2)}</pre></details>
      <Button type="button" variant="outline" disabled={busy||(!calendar.enabled&&(!policy?.enabled||!phoneEnabled||!botEnabled))} onClick={()=>void change(`/api/calendar-phone-reminders/${calendar.enabled?'disable':'enable'}`,calendar.enabled?{}:{manifestHash:calendar.prepared!.manifest_hash})}>{calendar.enabled?'Pause calendar calls':'Enable Archer calendar calls'}</Button>
      <p role="status" className="text-muted-foreground">{calendar.enabled?(calendar.ready?'Calendar calls are enabled.':'Calendar calls are enabled but paused or awaiting a connection check.'):'Calendar calling is off. Preparing calendars does not place a call.'}</p>
    </>}
  </section>;
}
