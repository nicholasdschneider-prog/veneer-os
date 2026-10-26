import type Database from 'better-sqlite3';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Current original task-owner questions, never a keyword consent/authority parser.
 * Unparseable scope stops dispatch. Reviewed source identity mapping is not eligibility.
 */
export function purchaseDecisionHolds(db: Database.Database, taskId: string) {
  const ownerReady=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_task_decision_owners'").get();
  const owner=ownerReady ? db.prepare(`SELECT o.conversation_id FROM purchase_task_decision_owners o JOIN purchase_event_bindings b ON b.task_id=o.task_id AND b.source_id=o.source_id WHERE o.task_id=?`).get(taskId) as {conversation_id:string}|undefined : undefined;
  if(owner && !db.prepare(`SELECT 1 FROM conversations c JOIN scheduled_tasks t ON t.id=?
    JOIN bot_registrations r ON r.conversation_id=c.id AND r.active=1
    WHERE c.id=? AND c.user_id=t.user_id AND c.assistant_id=t.assistant_id AND c.project_id IS t.project_id`).get(taskId,owner.conversation_id)) {
    return {held_orders:[],unresolved_scope_decisions:['ORIGINAL_DECISION_OWNER_UNAVAILABLE'],dispatch_blocked:true};
  }
  const questions = db.prepare(`SELECT d.id,d.version,d.proposal_json FROM bot_decisions d
    JOIN conversations c ON c.id=d.conversation_id JOIN scheduled_tasks t ON t.id=?
    WHERE d.state='needs_input' AND c.user_id=t.user_id AND c.assistant_id=t.assistant_id
    AND c.project_id IS t.project_id AND (? IS NULL OR c.id=?) ORDER BY d.id`).all(taskId,owner?.conversation_id ?? null,owner?.conversation_id ?? null) as
    {id:string;version:number;proposal_json:string}[];
  const source = db.prepare('SELECT source_id FROM purchase_event_bindings WHERE task_id=?').get(taskId) as {source_id:string}|undefined;
  const ready=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_order_scopes'").get();
  // order_id is null when the card names only an order number; the worker skips it by number.
  const held: {decision_id:string;version:number;order_number:string;order_id:string|null}[]=[];
  const unresolved:string[]=[];
  for(const q of questions) {
    let p:any;try{p=JSON.parse(q.proposal_json);}catch{unresolved.push(q.id);continue;}
    // Only structured declared roots. Never extract order numbers from question prose.
    // A task or workload card holds only the orders it lists, never the whole lane.
    const roots=p?.as_of?.orders;
    if(!Array.isArray(roots) || !roots.length || roots.length>100) {unresolved.push(q.id);continue;}
    const valid=roots.every((root:any)=>typeof root?.order_number==='string' && /^\d{1,30}$/.test(root.order_number)
      && (root.order_id===undefined || root.order_id===null || (typeof root.order_id==='string' && UUID.test(root.order_id))));
    if(!valid) {unresolved.push(q.id);continue;}
    for(const root of roots) {
      const mapping=!root.order_id && ready && source ? db.prepare('SELECT order_id FROM purchase_order_scopes WHERE source_id=? AND order_number=?').get(source.source_id,root.order_number) as {order_id:string}|undefined : undefined;
      held.push({decision_id:q.id,version:q.version,order_number:root.order_number,order_id:root.order_id ?? mapping?.order_id ?? null});
    }
  }
  return {held_orders:held,unresolved_scope_decisions:[...new Set(unresolved)],dispatch_blocked:unresolved.length>0};
}
