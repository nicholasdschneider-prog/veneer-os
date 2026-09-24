import { useEffect, useState } from 'react';
import type { BotDecision } from '@/lib/bots';
import { decisionCopy } from '@/lib/decisionPresentation';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

/** Keep the edit's version and exact text independent from polling snapshots. */
export function DecisionReplyEditor({decision,onSave,onEditing,className}:{decision:BotDecision;onSave:(body:string,version:number,handlingRevision?:number)=>Promise<void>;onEditing:(editing:boolean)=>void;className?:string}) {
  const original=decision.proposal.message_delivery?.payload.body ?? decisionCopy(decision.proposal).draft;
  const storageKey=`decision-reply-edit:${decision.id}`;
  const [edit,setEdit]=useState<{body:string;version:number;handlingRevision?:number}|null>(()=>{try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');return saved && typeof saved.body==='string' && Number.isInteger(saved.version)?saved:null;}catch{return null;}});
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{onEditing(!!edit);try{if(edit)sessionStorage.setItem(storageKey,JSON.stringify(edit));else sessionStorage.removeItem(storageKey);}catch{/* Keep the in-memory draft if storage is unavailable. */}},[edit,onEditing,storageKey]);
  useEffect(()=>()=>onEditing(false),[onEditing]);
  const conflict=!!edit && (edit.version!==decision.version || (decision.shared_queue && edit.handlingRevision!==decision.handling_revision));
  const allowed=decision.can_edit_reply===true && !['running','verified_completed'].includes(decision.state);
  if(!original && !edit)return null;
  return <div className={cn('space-y-3',className)}>
    {!edit ? allowed && <Button variant="outline" onClick={()=>setEdit({body:original!,version:decision.version,handlingRevision:decision.handling_revision})}>Edit customer reply</Button> : <>
      <label className="block text-sm font-medium">Edit customer reply · v{edit.version}
        <Textarea className="mt-2 min-h-48" value={edit.body} maxLength={12000} disabled={busy} onChange={e=>setEdit({...edit,body:e.target.value})} />
      </label>
      <p className="text-sm text-muted-foreground">Save a new version, review it, then approve. Saving does not authorize or send a message.</p>
      {conflict && <p role="alert" className="text-sm">The proposal or its handling changed. Your unsaved text is preserved. Copy any text you want to keep, cancel this edit, then edit the current version.</p>}
      {!allowed && <p role="alert" className="text-sm">You cannot amend this proposal in its current state. Your unsaved text is preserved.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || conflict || !allowed || !edit.body.trim()} onClick={async()=>{setBusy(true);setError('');try{await onSave(edit.body,edit.version,edit.handlingRevision);setEdit(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Save reply for review</Button>
        <Button variant="outline" disabled={busy} onClick={()=>{setEdit(null);setError('');}}>Cancel edit</Button>
      </div>
    </>}
  </div>;
}
