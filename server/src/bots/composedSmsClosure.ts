import {z} from 'zod';
import {uuid,hash,time,text,runtimeSchema,composeHash} from './composedSmsContract.js';
import {canonicalJson,canonicalSha256} from './canonical.js';
import type {ComposeRegistration} from './composedSmsTrust.js';
import {BotError} from './service.js';
const canonicalUuid=uuid.refine(v=>v===v.toLowerCase(),'Canonical lowercase UUID required');
const provenance=z.object({table:z.enum(['cs_conversations','cs_customers']),rowId:canonicalUuid,field:text,storedValue:text,revision:hash}).strict();
export const composeEvidenceIdentity=z.object({principalId:text,fullOrderOpsAccess:z.boolean(),accountId:text,nativeBusinessId:uuid,sourceOrigin:z.literal('https://orderops-dev-web-production.up.railway.app'),runtime:runtimeSchema}).strict();
export const composeClosureSchema=z.object({schemaVersion:z.literal('compose-sms-scope/v1'),identity:composeEvidenceIdentity,sourceRegistrationHash:hash,scopeEvidenceId:uuid,
 seeds:z.tuple([canonicalUuid,canonicalUuid,canonicalUuid]),
 nodes:z.array(z.object({id:text,kind:z.enum(['case','customer','order','email','phone']),value:text,provenance:z.array(provenance).min(1).max(100)}).strict()).min(1).max(500),
 edges:z.array(z.object({from:text,to:text,kind:z.enum(['case_customer','case_order','customer_email','customer_phone']),provenance}).strict()).max(2000),
 coverage:z.object({model:z.literal('persisted-cs-case-contact-closure/v1'),normalization:z.literal('ordinal-uuid-email-trim-lower-phone-nanp-evidence/v1'),fixedPoint:z.literal(true),complete:z.boolean(),unresolved:z.array(text).max(500),omitted:z.array(text).max(100)}).strict(),
 observedAt:time,expiresAt:time,snapshotHash:hash,materialHash:hash,
}).strict();
export function verifyComposeClosure(raw:unknown,r:ComposeRegistration,seeds:[string,string,string],principal:string,now:number,fullOrderOpsAccess=true){
 const w=composeClosureSchema.parse(raw);if(Buffer.byteLength(canonicalJson(w))>1024*1024)throw new BotError(409,'Source closure overflow');
 const {observedAt,expiresAt,snapshotHash,materialHash,scopeEvidenceId,...snapshot}=w;
 const expected={principalId:principal,fullOrderOpsAccess,accountId:r.sourceAccountId,nativeBusinessId:r.businessId,sourceOrigin:r.sourceOrigin,runtime:r.runtime};
 const {principalId,...sharedIdentity}=w.identity;
 if(canonicalSha256(w.identity)!==canonicalSha256(expected)||w.sourceRegistrationHash!==r.sourceRegistrationHash||canonicalJson(w.seeds)!==canonicalJson(seeds)||composeHash('compose-sms-scope-snapshot/v1',{...snapshot,scopeEvidenceId})!==snapshotHash||composeHash('compose-sms-scope-material/v1',{...snapshot,identity:sharedIdentity})!==materialHash)throw new BotError(409,'Authenticated closure identity, seeds or hash differs');
 if(Date.parse(observedAt)>now||Date.parse(expiresAt)<=now||Date.parse(expiresAt)<=Date.parse(observedAt)||Date.parse(expiresAt)-Date.parse(observedAt)>15000||Date.parse(expiresAt)>Date.parse(r.expiresAt))throw new BotError(409,'Closure observation expired');
 const nodes=new Map(w.nodes.map(n=>[n.id,n]));if(nodes.size!==w.nodes.length||w.nodes.some((n,i)=>n.id!==`${n.kind}:${n.value}`||(i>0&&w.nodes[i-1]!.id>=n.id)))throw new BotError(409,'Ambiguous closure nodes');
 const ordered=(xs:unknown[])=>xs.every((x,i)=>i===0||canonicalJson(xs[i-1])<canonicalJson(x));
 for(const n of w.nodes){if(!ordered(n.provenance))throw new BotError(409,'Unordered or duplicate provenance');
  if(['case','customer'].includes(n.kind)&&!canonicalUuid.safeParse(n.value).success)throw new BotError(409,'Noncanonical root');
  if(n.kind==='email'&&(n.value!==n.value.trim().toLowerCase()||!n.value.includes('@')))throw new BotError(409,'Noncanonical email');
  if(n.kind==='phone'&&!/^\+[1-9][0-9]{7,14}$/.test(n.value))throw new BotError(409,'Noncanonical phone');
 }
 if(!ordered(w.edges))throw new BotError(409,'Unordered or duplicate edges');
 const adjacency=new Map(w.nodes.map(n=>[n.id,new Set<string>()]));const edgeKeys=new Set<string>();
 for(const e of w.edges){if(!nodes.has(e.from)||!nodes.has(e.to))throw new BotError(409,'Unresolved closure edge');const kinds={case_customer:['case','customer'],case_order:['case','order'],customer_email:['customer','email'],customer_phone:['customer','phone']}[e.kind];if(nodes.get(e.from)!.kind!==kinds[0]||nodes.get(e.to)!.kind!==kinds[1])throw new BotError(409,'Malformed persisted relation');const from=nodes.get(e.from)!,to=nodes.get(e.to)!,p=e.provenance;
 const expectedField={case_customer:'customer_id',case_order:'related_order_id',customer_email:'email',customer_phone:'phone'}[e.kind];
 const normalized=e.kind==='customer_email'?p.storedValue.trim().toLowerCase():p.storedValue;
 if(p.table!==(from.kind==='case'?'cs_conversations':'cs_customers')||p.rowId!==from.value||p.field!==expectedField||normalized!==to.value)throw new BotError(409,'Relation provenance differs');
 // A bare ten-digit number has no sufficient country provenance in this v1.
 if(e.kind==='customer_phone'&&!/^\+[1-9][0-9]{7,14}$/.test(p.storedValue))throw new BotError(409,'Phone country provenance missing');
 const key=canonicalJson(e);if(edgeKeys.has(key))throw new BotError(409,'Duplicate closure edge');edgeKeys.add(key);adjacency.get(e.from)!.add(e.to);adjacency.get(e.to)!.add(e.from);}
 const component=(seed:string)=>{const start=`case:${seed}`;if(!nodes.has(start))throw new BotError(409,'Missing source seed');const seen=new Set([start]),queue=[start];while(queue.length){for(const x of adjacency.get(queue.shift()!)!)if(!seen.has(x)){seen.add(x);queue.push(x);}}return seen;};
 const target=new Set([...component(seeds[0]),...component(seeds[1])]),root=component(seeds[2]);
 const covered=new Set([...target,...root]);if(covered.size!==nodes.size)throw new BotError(409,'Unseeded closure nodes');
 return {rootId:seeds[2],scopeEvidenceId,materialHash,disjoint:w.coverage.complete&&!w.coverage.unresolved.length&&!w.coverage.omitted.length&&![...root].some(x=>target.has(x)),facts:w,expiresAt};
}
