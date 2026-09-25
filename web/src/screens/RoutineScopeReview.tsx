import { useEffect, useRef, useState } from 'react';

type Handoff={handoff_id:string;revision:number;status:string;source_origin:string;source_request:{requestKey:string;roots:string[];decision:{id:string;version:number;proposal_hash:string;event_revision:number}}};
type Review={proposal:unknown;decision_id:string;decision_version:number;proposal_hash:string;event_revision:number;
  handoff:Handoff|null;binding:{id:string;scope_kind:string}|null;binding_revoked:boolean;
  evidence:{id:string;fresh:boolean;handoff_current:boolean;snapshot:{source_revision:string;captured_at:string;cases:Array<{canonical_case:string;ticket:string;customer_id:string;customer_alias_ids:string[];orders:Array<{order_id:string}>;source_reference:string}>}}|null};
type Inventory={records:Array<{decision_id:string;decision_version:number;state:string}>;unavailable_count:number;total_count:number};
const root='/api/bot-communication/routine-messages';
async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load scope review.');return result;
}
export function RoutineScopeReview(){
  const [trust,setTrust]=useState('');
  const [inventory,setInventory]=useState<Inventory|null>(null);
  const [review,setReview]=useState<Review|null>(null);
  const [original,setOriginal]=useState<unknown>(null);
  const [selected,setSelected]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [setupBlocked,setSetupBlocked]=useState(false);
  const [roots,setRoots]=useState([{canonical_case:'',source_reference:''}]);
  const [scopeKind,setScopeKind]=useState('unknown');
  const [reference,setReference]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [notice,setNotice]=useState('');
  const lock=useRef(false);
  const mounted=useRef(true);
  async function run(fn:()=>Promise<void>){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{await fn();}catch(e){if(mounted.current)setError((e as Error).message);}finally{lock.current=false;if(mounted.current)setBusy(false);}
  }
  async function load(){await run(async()=>{
    const setup=await request<{status:string;receipt:{trust_id:string}|null}>(root+'/setup');
    if(!mounted.current)return;
    if(setup.status!=='registered'||!setup.receipt){setSetupBlocked(true);setInventory(null);return;}
    const id=setup.receipt.trust_id;setTrust(id);setSetupBlocked(false);
    const list=await request<Inventory>(root+'/hold-scopes/list',{trust_id:id});if(mounted.current)setInventory(list);
  });}
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;};},[]);
  async function refresh(id=selected){await run(async()=>{
    // Clear stale review first. A failed read must not leave actionable old scope.
    setReview(null);setOriginal(null);setConfirmed(false);setNotice('');
    const data=await request<Review>(root+'/hold-scopes/review',{trust_id:trust,decision_id:id});
    if(mounted.current){setReview(data);setOriginal(data.proposal);setUncertain(false);setScopeKind('unknown');setReference('');setRoots([{canonical_case:'',source_reference:''}]);}
  });}
  async function mutate(path:string,body:unknown){await run(async()=>{
    try{await request(root+path,body);setUncertain(true);setConfirmed(false);setNotice('Recorded. Refresh the selected decision to read its current receipt before continuing.');}
    catch{setUncertain(true);setConfirmed(false);throw new Error('The result is uncertain. Refresh the selected decision to reconcile the existing record. Do not submit another request.');}
  });}
  function tuple(){return {trust_id:trust,decision_id:review!.decision_id,decision_version:review!.decision_version,proposal_hash:review!.proposal_hash,event_revision:review!.event_revision};}
  const button='min-h-11 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-4';
  const input='min-h-11 w-full rounded-lg border border-zinc-300 bg-transparent p-2 dark:border-zinc-600';
  return <main className="h-full overflow-y-auto mx-auto max-w-3xl space-y-6 p-5 pb-16 sm:p-8">
    <header className="space-y-2"><p className="text-sm text-zinc-500">Elkhart RV Parts · Owner review</p><h1 className="text-2xl font-semibold">Review which cases a hold covers</h1><p>Identify the source cases for one existing decision. OrderOps checks all related cases, then you review the complete result. This does not approve a reply or change the original decision.</p></header>
    {error&&<p role="alert" className="rounded-lg border border-amber-400 p-4">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {busy&&<p role="status">Checking the current record…</p>}
    {setupBlocked&&<p>Complete the <a className="underline" href="#/routine-reply-setup">routine reply setup</a> before preparing case handoffs. No case approval is requested here yet.</p>}
    {!inventory&&!busy&&<button className={button} onClick={()=>void load()}>Check setup</button>}
    {inventory&&<section className="space-y-3">
      <p>{inventory.total_count} decisions in the complete inventory. {inventory.unavailable_count>0&&`${inventory.unavailable_count} cannot be viewed with your current access and remain covered by the execution checks.`}</p>
      <label className="block space-y-1"><span>Decision to review</span><select className={input} value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setReview(null);setOriginal(null);setUncertain(false);setConfirmed(false);setNotice('');}}><option value="">Select a decision</option>{inventory.records.map(d=><option key={d.decision_id} value={d.decision_id}>{d.decision_id} · version {d.decision_version} · {d.state}</option>)}</select></label>
      <button className={button} disabled={busy||!selected} onClick={()=>void refresh()}>Refresh selected decision</button>
    </section>}
    {review&&<>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">Original decision · version {review.decision_version}</h2><p>Read the full decision before selecting cases. A handoff cannot narrow or approve this decision.</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(original,null,2)}</pre></section>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">1. Prepare source case lookup</h2><p>Use actual case IDs and their record links from OrderOps. Include every starting case relevant to this decision. These are lookup instructions; OrderOps must still verify the full related-case set.</p>
        <fieldset disabled={busy||uncertain} className="space-y-4">{roots.map((r,i)=><div key={i} className="space-y-2"><label className="block">Source case ID {i+1}<input className={input} value={r.canonical_case} onChange={e=>setRoots(old=>old.map((r,j)=>j===i?{...r,canonical_case:e.target.value}:r))}/></label><label className="block">Source record link {i+1}<input type="url" className={input} value={r.source_reference} onChange={e=>setRoots(old=>old.map((r,j)=>j===i?{...r,source_reference:e.target.value}:r))}/></label>{roots.length>1&&<button className="min-h-11 underline" onClick={()=>setRoots(old=>old.filter((_,j)=>j!==i))}>Remove case {i+1}</button>}</div>)}
        <button className="min-h-11 underline" disabled={roots.length>=100} onClick={()=>setRoots(old=>[...old,{canonical_case:'',source_reference:''}])}>Add another source case</button>
        <div><button className={button} disabled={roots.some(r=>!r.canonical_case.trim()||!r.source_reference.trim())} onClick={()=>void mutate('/hold-scopes/handoffs',{...tuple(),request_key:crypto.randomUUID(),expected_handoff_id:review.handoff?.handoff_id??null,roots:roots.map(r=>({canonical_case:r.canonical_case.trim(),source_reference:r.source_reference.trim()})),confirmation:'source-locators-only-not-scope-classification'})}>Prepare case handoff</button></div></fieldset>
        {review.handoff&&<div className="space-y-2 border-t pt-3"><p>Handoff revision {review.handoff.revision}: {review.handoff.status}. Source verification is separate from scope classification.</p><label className="block">Handoff reference<input readOnly className={input} value={review.handoff.handoff_id}/></label>
          {review.handoff.status==='current'&&<><p>Give the original OrderOps custodian this exact request for the named executor’s authenticated source connection. The request cannot send a customer message.</p><label className="block">Exact source lookup request<textarea readOnly rows={8} className={input+' text-sm'} value={JSON.stringify(review.handoff.source_request,null,2)}/></label><p className="text-sm break-all">Source endpoint: {review.handoff.source_origin}/api/cs/routine/scope-evidence</p></>}
          <button className={button} disabled={busy||uncertain||review.handoff.status!=='current'} onClick={()=>void mutate('/hold-scopes/handoffs/revoke',{trust_id:trust,handoff_id:review.handoff!.handoff_id,reason:'Owner withdrew source case lookup through scope review'})}>Revoke case handoff</button>
        </div>}
      </section>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">2. Review the complete source result</h2>
        {!review.evidence?<p>No source projection has been received. The OrderOps custodian must complete the prepared lookup.</p>:<><p>Observed {review.evidence.snapshot.captured_at}. {review.evidence.fresh?'Current observation.':'This retained observation can be reviewed; execution requires a new matching observation.'}</p>{!review.evidence.handoff_current&&<p role="status">This observation no longer matches the current handoff. The source must return a new matching projection before case-set classification.</p>}<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Ticket</th><th className="p-2">Case</th><th className="p-2">Related identities</th></tr></thead><tbody>{review.evidence.snapshot.cases.map(c=><tr key={c.canonical_case}><td className="p-2">{c.ticket}</td><td className="max-w-56 break-all p-2">{c.canonical_case}<br/>{c.source_reference}</td><td className="max-w-56 break-all p-2">Customer: {c.customer_id}<br/>Aliases: {c.customer_alias_ids.join(', ')||'None'}<br/>Orders: {c.orders.map(o=>o.order_id).join(', ')||'None'}</td></tr>)}</tbody></table></div></>}
        <fieldset disabled={busy||uncertain} className="space-y-3"><label className="block">Scope of the original decision<select className={input} value={scopeKind} onChange={e=>{setScopeKind(e.target.value);setConfirmed(false);}}><option value="unknown">Unknown — keep blocking</option><option value="business_wide">Entire business — keep blocking</option><option value="case_set" disabled={!review.evidence?.handoff_current}>Only the complete source case set shown above</option></select></label>
          <label className="block">Evidence supporting your scope review<textarea className={input} value={reference} onChange={e=>{setReference(e.target.value);setConfirmed(false);}}/></label>
          <label className="flex gap-3"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>I reviewed the original decision and its full scope. This classification does not approve a business action or customer reply.</span></label>
          <button className={button} disabled={!confirmed||!reference.trim()||(scopeKind==='case_set'&&!review.evidence?.handoff_current)} onClick={()=>void mutate('/hold-scopes/bind',{...tuple(),evidence_id:scopeKind==='case_set'?review.evidence!.id:null,request_key:crypto.randomUUID(),expected_binding_id:review.binding?.id??null,scope_kind:scopeKind,review_reference:reference.trim(),confirmation:'complete-current-scope-not-business-approval'})}>Record scope classification</button>
        </fieldset>
        {review.binding&&<div className="space-y-2 border-t pt-3"><p className="text-sm">A recorded classification does not establish send readiness. Changed handoffs or source evidence remain blocking.</p><p>Recorded scope: {review.binding.scope_kind}{review.binding_revoked?' (revoked)':''}.</p><button className={button} disabled={busy||uncertain||review.binding_revoked} onClick={()=>void mutate('/hold-scopes/revoke',{trust_id:trust,binding_id:review.binding!.id,reason:'Owner withdrew scope classification through scope review'})}>Revoke scope classification</button></div>}
      </section>
    </>}
    <a className="inline-block min-h-11 py-3 underline" href="#/bot-guide?feature=routine-scope-handoff">Read the scope review guide</a>
  </main>;
}
