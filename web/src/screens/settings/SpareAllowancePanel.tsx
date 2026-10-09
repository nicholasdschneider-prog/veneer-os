import { useCallback, useEffect, useState } from 'react';
import { requestJson } from '../../lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Task {id:string;title:string;output:string;status:string;completed_batches:number;max_batches:number;conversation_id:string}
interface Run {id:string;task_id:string;status:string;reason:string|null;account_id:string;batch:number;usage_before:number;usage_after:number|null;started_at:string}
interface Backlog {
  settings:{enabled:number}; tasks:Task[];runs:Run[];
  accounts:{provider:string;account_id:string;reason:string;checked_at:string;snapshot_json:string}[];
  conversations:{id:string;title:string|null;provider:string;model:string}[];
  connectedAccounts:{provider:string;id:string;label:string}[];
}
const field = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm';
export function SpareAllowancePanel() {
  const [data,setData] = useState<Backlog|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [adding,setAdding] = useState(false);
  const [conversation,setConversation] = useState('');
  const [accounts,setAccounts] = useState<string[]>([]);
  const [title,setTitle] = useState(''); const [prompt,setPrompt] = useState(''); const [output,setOutput] = useState('');
  const [priority,setPriority] = useState(0); const [batches,setBatches] = useState(1);
  const [requestKey,setRequestKey] = useState(()=>crypto.randomUUID());
  const load = useCallback(async()=>{
    try {setData(await requestJson<Backlog>('/api/spare-allowance'));} catch(e) {setError((e as Error).message);}
  },[]);
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),15_000);return ()=>clearInterval(timer);},[load]);
  async function mutate(path:string,body:unknown,method='POST') {
    setBusy(true);setError(null);
    try {await requestJson(`/api/spare-allowance${path}`,{method,body:JSON.stringify(body)});await load();return true;}
    catch(e){setError((e as Error).message);return false;}finally{setBusy(false);}
  }
  const source = data?.conversations.find(c=>c.id===conversation);
  return <Card>
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
      <CardTitle>Use spare allowance</CardTitle>
      {data && <Button variant="outline" disabled={busy} onClick={()=>void mutate('/settings',{enabled:!data.settings.enabled})}>{data.settings.enabled ? 'Pause all' : 'Enable queue'}</Button>}
    </CardHeader>
    <CardContent className="space-y-5">
      <p className="text-sm text-muted-foreground">Useful optional work during the final six hours before each account resets. Runs outside 8 a.m.–5 p.m. Eastern every day, targets 1% remaining, and yields to normal work. Accounts are skipped if business hours intervene before reset or paid fallback is not verified disabled.</p>
      <p className="text-xs text-muted-foreground">Runs use short checkpoints. Meter delays can leave more than 1% unused. Publishing, paid services, and detached rendering jobs require their existing authorization.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!data ? <Button variant="outline" onClick={()=>void load()}>Load backlog</Button> : <>
        <p className="text-sm">Queue {data.settings.enabled ? 'enabled' : 'paused'} · {data.tasks.filter(t=>t.status==='ready').length} ready tasks</p>
        {data.tasks.map(t=><div key={t.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{t.title}</strong><span className="text-xs text-muted-foreground">{t.status} · {t.completed_batches}/{t.max_batches} batches</span></div>
          <p className="break-words text-sm text-muted-foreground">{t.output}</p>
          <div className="flex flex-wrap gap-2">
            <a className="text-sm underline underline-offset-4" href={`/#/chat/${t.conversation_id}`}>Open original chat</a>
            {['ready','paused'].includes(t.status) && <Button size="sm" variant="outline" disabled={busy} onClick={()=>void mutate(`/tasks/${t.id}`,{status:t.status==='ready'?'paused':'ready'},'PATCH')}>{t.status==='ready'?'Pause task':'Resume task'}</Button>}
            {t.status==='blocked' && <p className="text-xs text-muted-foreground">Review saved output in the original chat. This batch will not be retried. Ask the bot to prepare a distinct continuation task with the reviewed checkpoint.</p>}
          </div>
        </div>)}
        <Button variant="outline" onClick={()=>setAdding(!adding)}>{adding?'Close task form':'Add optional task'}</Button>
        {adding && <form className="space-y-3" onSubmit={async e=>{e.preventDefault();if(await mutate('/tasks',{request_key:requestKey,conversation_id:conversation,title,prompt,output,account_ids:accounts,priority,max_batches:batches})){setAdding(false);setTitle('');setPrompt('');setOutput('');setRequestKey(crypto.randomUUID());}}}>
          <label className="block space-y-1 text-sm"><span>Original bot or project chat</span><select required className={field} value={conversation} onChange={e=>{setConversation(e.target.value);setAccounts([]);}}><option value="">Choose a chat</option>{data.conversations.map(c=><option key={c.id} value={c.id}>{c.title??'Untitled'} · {c.provider} · {c.model}</option>)}</select></label>
          <p className="text-xs text-muted-foreground">Choose an existing chat with an explicit Claude or Codex model. Its current project, identity, and access rules remain in effect.</p>
          <fieldset className="space-y-2"><legend className="text-sm">Allowed subscription accounts</legend>{data.connectedAccounts.filter(a=>a.provider===source?.provider).map(a=><label key={a.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={accounts.includes(a.id)} onChange={e=>setAccounts(e.target.checked?[...accounts,a.id]:accounts.filter(id=>id!==a.id))}/>{a.label}</label>)}</fieldset>
          <label className="block space-y-1 text-sm"><span>Task name</span><input required maxLength={200} className={field} value={title} onChange={e=>setTitle(e.target.value)}/></label>
          <label className="block space-y-1 text-sm"><span>Required deliverable</span><input required maxLength={2000} className={field} value={output} onChange={e=>setOutput(e.target.value)} placeholder="Six gallery views and a saved Blender model"/></label>
          <label className="block space-y-1 text-sm"><span>Instructions and source references</span><textarea required maxLength={20000} rows={4} className={field} value={prompt} onChange={e=>setPrompt(e.target.value)}/></label>
          <div className="flex flex-wrap gap-3"><label className="space-y-1 text-sm"><span>Priority (higher runs first)</span><input type="number" min={-100} max={100} required className={field} value={priority} onChange={e=>setPriority(Number(e.target.value))}/></label><label className="space-y-1 text-sm"><span>Maximum batches</span><input type="number" min={1} max={100} required className={field} value={batches} onChange={e=>setBatches(Number(e.target.value))}/></label></div>
          <Button type="submit" disabled={busy||!accounts.length}>Save task</Button>
        </form>}
        <details><summary className="cursor-pointer text-sm">Account eligibility and recent results</summary><div className="mt-3 space-y-3">
          {!data.accounts.length && <p className="text-sm text-muted-foreground">Usage is evaluated when ready tasks exist, outside business hours, and normal work is idle.</p>}
          {data.accounts.map(a=><p key={`${a.provider}:${a.account_id}`} className="break-words text-sm">{data.connectedAccounts.find(c=>c.provider===a.provider&&c.id===a.account_id)?.label??a.account_id}: {a.reason}<span className="block text-xs text-muted-foreground">Last checked {new Date(a.checked_at).toLocaleString()}</span></p>)}
          {data.runs.map(r=><p key={r.id} className="break-words text-sm">{data.tasks.find(t=>t.id===r.task_id)?.title??'Task'} · batch {r.batch} · {r.status}<span className="block text-xs text-muted-foreground">{r.reason??'Running'} · usage at launch {r.usage_before}%{r.usage_after===null?'':` · last observed ${r.usage_after}%`}</span></p>)}
        </div></details>
      </>}
    </CardContent>
  </Card>;
}
