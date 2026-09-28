import {useEffect,useRef,useState} from 'react';
type Enrollment={request_key:string;business_id:string;executor_id:string;source_origin:string;account_id:string;principal_id:string;source_deployment:string;custody_receipt:string};
type Options={configured:boolean;businesses:{id:string;name:string}[];executors:{id:string;title:string;business_team_id:string}[]};
type Review={review_hash:string;status:string;enrollment:Record<string,unknown>;receipt:Record<string,unknown>|null};
async function request<T>(path:string,body?:unknown):Promise<T>{
 const r=await fetch('/api/purchase-timing/setup'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 const value=await r.json();if(!r.ok)throw new Error(value.error||'Could not check timing setup');return value;
}
export function PurchaseTimingSetup(){
 const [options,setOptions]=useState<Options|null>(null),[review,setReview]=useState<Review|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const [form,setForm]=useState<Enrollment>({request_key:'',business_id:'',executor_id:'',source_origin:'',account_id:'',principal_id:'',source_deployment:'',custody_receipt:''});
 const lock=useRef(false);
 async function load(){try{setOptions(await request<Options>(''));setError('');}catch(e){setError((e as Error).message);}}
 useEffect(()=>{void load();},[]);
 async function action(kind:'review'|'confirm'|'status'){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(kind==='status'){
    const receipt=await request<Record<string,unknown>>('/registrations/'+encodeURIComponent(form.request_key));
    setReview({review_hash:'',enrollment:{},status:receipt.revoked?'revoked':'registered',receipt});setUncertain(false);
   }else if(kind==='review')setReview(await request<Review>('/review',form));
   else setReview(await request<Review>('/confirm',{enrollment:form,review_hash:review!.review_hash,confirm:true}));
  }catch(e){setError((e as Error).message);if(kind==='confirm')setUncertain(true);}
  finally{lock.current=false;setBusy(false);}
 }
 const input='w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-base outline-blue-500 dark:border-zinc-600';
 const button='relative rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50';
 const touch=<span aria-hidden="true" className="pointer-fine:hidden absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2"/>;
 const fields:[keyof Enrollment,string][]=[['request_key','Stable registration key'],['source_origin','Source HTTPS origin'],['account_id','Source account ID'],['principal_id','Source principal ID'],['source_deployment','Verified source deployment'],['custody_receipt','Source custody receipt']];
 return <main className="h-full overflow-y-auto mx-auto w-full max-w-2xl space-y-6 p-5 pb-16 antialiased sm:p-8">
  <header className="space-y-3"><p className="text-base text-zinc-500 sm:text-sm">Owner setup</p><h1 className="text-balance text-2xl font-semibold tracking-tight">Connect purchase timing verification</h1><p className="text-pretty text-base sm:text-sm">Connect the verified source account to its existing purchasing bot. This registers the connection only; it does not approve or place an order.</p></header>
  {error&&<p role="alert" className="text-base text-red-700 dark:text-red-300 sm:text-sm">{error}</p>}
  {!options&&!error&&<p role="status">Checking owner access…</p>}
  {options&&!options.configured&&<section className="space-y-3 border-t border-zinc-950/10 pt-5 dark:border-white/10"><h2 className="font-semibold">Technical setup is still needed</h2><p>Platform Dev and the source operator must configure a dedicated purchase-timing service identity and verify source custody before you can review registration.</p><p>No existing return, routine-message, or shipping credential can be reused.</p></section>}
  {options?.configured&&!review&&!uncertain&&<form className="space-y-5" onSubmit={e=>{e.preventDefault();void action('review');}}>
   <p className="text-base sm:text-sm">Use the exact nonsecret connection details supplied by the source operator. Do not enter credentials.</p>
   <div className="space-y-2"><label className="block" htmlFor="timing-business">Business</label><select id="timing-business" name="business_id" className={input} required value={form.business_id} onChange={e=>setForm({...form,business_id:e.target.value,executor_id:''})}><option value="">Choose your business</option>{options.businesses.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
   <div className="space-y-2"><label className="block" htmlFor="timing-executor">Existing purchasing bot</label><select id="timing-executor" name="executor_id" className={input} required value={form.executor_id} onChange={e=>setForm({...form,executor_id:e.target.value})}><option value="">Choose the original executor</option>{options.executors.filter(x=>x.business_team_id===form.business_id).map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></div>
   {fields.map(([name,label])=><label key={name} htmlFor={'timing-'+name} className="block space-y-2"><span>{label}</span><input className={input} id={'timing-'+name} name={name} type={name==='source_origin'?'url':'text'} required autoComplete="off" value={form[name]} onChange={e=>setForm({...form,[name]:e.target.value})}/></label>)}
   <button type="submit" className={button} disabled={busy}>Review connection{touch}</button>
  </form>}
  {review&&<section className="space-y-4 border-t border-zinc-950/10 pt-5 dark:border-white/10"><h2 className="font-semibold">{review.status==='registered'?'Connection registered':review.status==='revoked'?'Connection revoked':'Review the exact connection'}</h2><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-100 p-4 text-sm dark:bg-zinc-900">{JSON.stringify(review.receipt??review.enrollment,null,2)}</pre><p>The source operator must still configure and verify its consumer. Existing timing holds remain until both sides accept the exact contract.</p>
   {!uncertain&&review.status==='ready'&&<div className="flex flex-wrap items-center gap-6"><button type="button" className={button} disabled={busy} onClick={()=>void action('confirm')}>Confirm connection{touch}</button><button type="button" className="relative text-sm underline" disabled={busy} onClick={()=>setReview(null)}>Edit details{touch}</button></div>}
  </section>}
  {uncertain&&<section className="space-y-4"><p role="status">The confirmation result is uncertain. Keep this registration key and check its status. This check will not register again.</p><button type="button" className={button} disabled={busy} onClick={()=>void action('status')}>Check registration status{touch}</button></section>}
  {busy&&<p role="status">Checking the connection…</p>}
  <p className="text-base sm:text-sm"><a className="text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=purchase-timing-verifier">Read the setup guide</a></p>
 </main>;
}
