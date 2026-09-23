/** Presentation only. No classification authorizes a claim or changes a record. */
export function csDraftState(d: {state:string;receipt:string|null;claim_key:string|null;authorized_by:number|null},
  context: {retired:boolean;routine:boolean;delegated:boolean;decision?:{id:string;version:number;state:string;answer:string|null};stale:boolean}) {
  const result = (state:string,label:string,reason:string) => ({state,label,reason,execute:false as const});
  if(context.retired || d.state==='discarded') return result('retired','Retired without delivery','The original payload and separate retirement history are retained.');
  if(d.state==='sent' && d.receipt) return result('sent','Sent with receipt','Delivery is recorded below; this does not complete other case obligations.');
  if(d.state==='uncertain' || d.state==='sent') return result('unknown','Delivery needs reconciliation','Check the original source receipt. Do not retry or infer delivery.');
  if(d.state==='sending' || d.claim_key) return result('sending','Sending / awaiting receipt','The delivery claim is held. Unknown effects require read-only reconciliation, never another send.');
  if(context.stale) return result('blocked','Technically blocked','The bound proposal version changed. The owning bot must reconcile exact scope; no approval carries forward automatically.');
  const decision=context.decision;
  if(decision && decision.state==='needs_input' && !decision.answer) return result('needs_decision','Needs human decision','Answer the existing central decision. This card is not a second send-approval request.');
  if(decision?.answer && decision.answer!=='approve') return result('held','Human direction remains binding','A reject, defer or withdrawal does not authorize delivery. The owning bot must retain that direction.');
  if(d.state==='queued') return result('queued','Queued for guarded delivery','Queued is not sent. The named executor must pass fresh source and authority checks.');
  if(context.routine) return result('blocked','Routine-authorized · technically blocked','Recorded standing-policy authority requires current source proof, lease, material and duplicate checks.');
  if(context.delegated || d.authorized_by!==null) return result('blocked','Authorized · technically blocked','Recorded message authority is not a delivery receipt. The named executor owns guarded follow-through.');
  if(decision?.answer==='approve') return result('blocked','Business decision approved · message unbound','The business answer remains recorded. This ordinary draft has no exact message authorization; do not attach an approval to different text.');
  return result('blocked','Authority / source setup unresolved','Platform Dev and the source owner must resolve exact message authority or routine policy, category and source verification. This draft is not certified routine. Do not request duplicate per-email approval as a workaround.');
}
