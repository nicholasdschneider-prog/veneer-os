import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {BotError} from './service.js';
import {originalActionDigest,verifyLineage} from './composedSmsCorrectionContract.js';
type Row={original_action_digest:string;native_action_id:string;business_id:string;decision_id:string;authority_id:string};
function original(db:Database.Database,authorityId:string){
 const g=db.prepare('SELECT id,action_id,snapshot_json FROM bot_composed_sms_authorities WHERE id=?').get(authorityId) as {id:string;action_id:string;snapshot_json:string}|undefined;
 if(!g)throw new BotError(409,'Durable original authority missing');const s=JSON.parse(g.snapshot_json),business=s.binding?.business_id,decision=s.tuple?.decisionId??s.native?.existing_consumption?.decision_id;
 if(typeof business!=='string'||typeof decision!=='string'||g.action_id!==originalActionDigest(business,decision))throw new BotError(409,'Unknown or conflicting historical action lineage');
 return {digest:g.action_id,business,decision};
}
/** Caller must hold the immediate derivation transaction. No release on expiry,
 * revocation or UNKNOWN. Existing persisted dispatch UUID always wins. */
export function reserveComposeLineage(db:Database.Database,authorityId:string){return db.transaction(()=>{
 const o=original(db,authorityId),prior=db.prepare('SELECT * FROM compose_action_lineages WHERE original_action_digest=? OR authority_id=?').all(o.digest,authorityId) as Row[];
 const dispatch=db.prepare('SELECT action_id,tuple_json FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(authorityId) as {action_id:string;tuple_json:string}|undefined;
 if(dispatch){const a=JSON.parse(dispatch.tuple_json);if(a.nativeActionId!==dispatch.action_id||a.businessId!==o.business||a.authorityId!==authorityId)throw new BotError(409,'Historical dispatch lineage conflicts');}
 if(prior.length){if(prior.length!==1||prior[0]!.authority_id!==authorityId||prior[0]!.original_action_digest!==o.digest||prior[0]!.business_id!==o.business||prior[0]!.decision_id!==o.decision||(dispatch&&prior[0]!.native_action_id!==dispatch.action_id))throw new BotError(409,'Original action already mapped to conflicting authority');return prior[0]!;}
 const row={original_action_digest:o.digest,native_action_id:dispatch?.action_id??crypto.randomUUID(),business_id:o.business,decision_id:o.decision,authority_id:authorityId};
 db.prepare('INSERT INTO compose_action_lineages(original_action_digest,native_action_id,business_id,decision_id,authority_id) VALUES(@original_action_digest,@native_action_id,@business_id,@decision_id,@authority_id)').run(row);return row;
}).immediate();}
/** Read-only exact-ID export from persisted records, including pre-adoption old
 * dispatches. No new UUID, guessed alias, or mutation on service GET. */
export function readComposeLineage(db:Database.Database,nativeActionId:string,nativeIssuer:string){
 const d=db.prepare('SELECT authority_id,tuple_json FROM bot_composed_sms_dispatch_authorities WHERE action_id=?').get(nativeActionId) as {authority_id:string;tuple_json:string}|undefined;
 if(!d)throw new BotError(404,'Exact durable dispatch action required');const o=original(db,d.authority_id),a=JSON.parse(d.tuple_json);
 const row=db.prepare('SELECT * FROM compose_action_lineages WHERE original_action_digest=? OR native_action_id=?').all(o.digest,nativeActionId) as Row[];
 if(a.nativeActionId!==nativeActionId||a.authorityId!==d.authority_id||a.businessId!==o.business||row.length>1||row.some(x=>x.native_action_id!==nativeActionId||x.authority_id!==d.authority_id||x.original_action_digest!==o.digest||x.business_id!==o.business||x.decision_id!==o.decision))throw new BotError(409,'Conflicting persisted action lineage');
 return verifyLineage({schemaVersion:'native-compose-sms-action-lineage/v1',nativeIssuer,businessId:o.business,decisionId:o.decision,channel:'sms',originalActionDigest:o.digest,nativeActionId});
}
