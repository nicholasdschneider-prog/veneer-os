import { z } from 'zod';
import type Database from 'better-sqlite3';
import { BotError } from './service.js';
import { canonicalJson, canonicalSha256 } from './canonical.js';
import { customerEmailNative } from './customerEmailNative.js';
import { emailRegistrationCurrent } from './customerEmailTrust.js';
import { emailInput, emailHash, emailId, emailKey, emailSchemaManifest, emailPrebindCapability, emailRegistration, type EmailRegistration } from './customerEmailContract.js';
import { exactDraftPayload } from './draftPayload.js';
import type { EmailIO } from './customerEmailIO.js';
export const emailNativeLocator = z.object({
    key: emailKey, revision: emailHash,
    references: z.array(z.object({
        namespace: z.enum(['native_record', 'source_case', 'source_customer', 'source_order']),
        id: emailId, field: z.string().min(1).max(200),
        provenance: z.literal('retained-native-structured-field')
    }).strict()).max(30),
    resolution: z.literal('SOURCE_CLOSURE_REQUIRED'),
    unknown: z.boolean(), unresolved_fields:z.array(z.string().min(1).max(200)).max(30)
}).strict();
export const emailPrebindResponse = z.object({
    schemaVersion: z.literal('customer-email-prebind-context/v1'), execute: z.literal(false),
    dispatchEntitlement: z.literal(false), authority: z.literal(false), ready: z.literal(false),
    registration_id: emailId, registration_hash: emailHash, capability_hash: emailHash,
    observed_at:z.string().datetime(),expires_at:z.string().datetime(),
    input: emailInput, business_id: emailId, payload: exactDraftPayload, payload_hash: emailHash,
    source_hash: emailHash, context_revision: emailHash, acl_hash: emailHash, inventory_hash: emailHash,
    records: z.array(emailNativeLocator).max(5000), locator_hash: emailHash,
    complete: z.literal(true), unreviewed_media: z.array(emailKey).length(0),
    scope_complete: z.literal(false), scope_blocker: z.literal('AUTHENTICATED_SOURCE_CLOSURES_REQUIRED')
}).strict();
export const EMAIL_PREBIND_WIRE = {
    contract:'customer-email-prebind-context/v1', input:emailSchemaManifest(emailInput),
    capability:emailSchemaManifest(emailPrebindCapability), registration:emailSchemaManifest(emailRegistration), response:emailSchemaManifest(emailPrebindResponse),
    path:'/api/customer-email-direction/verifier/prebind-context', registrationIdentity:'authenticated-header-only',
    bounds:{records:5000,contextBytes:2000000,responseBytes:2000000,readEnvelopeMs:5000},
    locators:'retained-structured-references-not-aliases-mapping-or-unrelatedness',
    failure:'missing-context-media-cap-unknown-structure-no-usable-closure', effect:'read-only-never-entitles'
} as const;
export const EMAIL_PREBIND_CONTRACT_HASH=canonicalSha256(EMAIL_PREBIND_WIRE);
// Only explicitly retained structured fields, never prose, descriptive ticket/customer
// strings, guessed aliases or a human/bot assertion of approval. Even these references
// need genuine authenticated source resolution and complete closure before binding.
const rootFields: Record<string,Array<[string,string]>>={
    decision:[['proposal_json','message_delivery.canonical_case']],
    delegation:[['scope_json','canonical_case']],
    composition:[['snapshot_json','scope.canonical_case'],['snapshot_json','scope.contact_case']],
    customer_email:[['projection_json','canonicalCaseId'],['projection_json','canonicalCustomerId'],['projection_json','canonicalOrderId']],
    routine:[['locator_scope_json','canonical_case']]
};
export function retainedEmailLocators(list:Array<{key:string;revision:string;row:Record<string,unknown>}>) {
    return list.map(({key,revision,row})=>{
        const unresolved_fields:string[]=[];
        const references:z.infer<typeof emailNativeLocator>['references']=[];
        for(const field of ['draft_id','decision_id','authority_id','original_decision_id','native_action_id','proof_id','locator_proof_id','source_id']) {
            const v=row[field];
            if(emailId.safeParse(v).success)references.push({namespace:'native_record',id:String(v),field,provenance:'retained-native-structured-field'});
        }
        for(const [column,path] of rootFields[key.split(':')[0]!]??[]) {
            let value:unknown=row;
            if(column) {
                if(row[column]===null||row[column]===undefined){unresolved_fields.push(`${column}.${path}`);continue;}
                value=JSON.parse(String(row[column]));
                if(!value||typeof value!=='object'||Array.isArray(value))throw new BotError(409,'Malformed retained structured locator');
            }
            for(const component of path.split('.'))value=value&&typeof value==='object'?(value as Record<string,unknown>)[component]:undefined;
            if(value===undefined||value===null){unresolved_fields.push(column?`${column}.${path}`:path);continue;}
            if(!emailId.safeParse(value).success){unresolved_fields.push(column?`${column}.${path}`:path);continue;} // Explicitly unresolved; no normalization.
            const namespace= /customer/i.test(path)?'source_customer':/order/i.test(path)?'source_order':'source_case';
            references.push({namespace,id:String(value),field:column==='locator_scope_json'?`routine_source_proofs:${row.locator_proof_id}.scope_json.${path}`:column?`${column}.${path}`:path,provenance:'retained-native-structured-field'});
        }
        return emailNativeLocator.parse({key,revision,references,resolution:'SOURCE_CLOSURE_REQUIRED',unknown:unresolved_fields.length>0||!references.some(x=>x.namespace!=='native_record'),unresolved_fields});
    }).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
}
export function customerEmailPrebind(db:Database.Database,io:EmailIO) {
    const native=customerEmailNative(db);
    return (registrationId:string,raw:unknown)=>db.transaction(()=>{
        const observed=io.now(),p=emailInput.parse(raw),r=io.registration(registrationId);
        if(r.id!==registrationId)throw new BotError(403,'Exact authenticated registration required');
        function check(current:EmailRegistration) {
            const h=emailRegistrationCurrent(db,current,io.now());
            const c=current.prebindCapability;
            if(!c||c.contractHash!==EMAIL_PREBIND_CONTRACT_HASH||Date.parse(c.expiresAt)<=io.now()||canonicalSha256(c.input)!==canonicalSha256(p))
                throw new BotError(403,'EXPLICIT_EXACT_PREBIND_CAPABILITY_REQUIRED');
            return h;
        }
        const registrationHash=check(r), n=native.serviceSnapshot(r,p);
        if(n.unreviewedMedia.length)throw new BotError(409,'PREBIND_UNREVIEWED_MEDIA: complete authorized byte review unavailable');
        if(n.payload.account!==r.payloadAccount)throw new BotError(403,'Exact enrolled payload account required');
        // Competitor media has no accepted native byte-review manifest either.
        // Do not certify a complete usable read merely because only target media
        // was checked; expose neither paths nor unrelated private payloads.
        const media= /!\[|(?:\/uploads\/|\/attachments\/|\/Users\/|\/home\/)|"(?:attachments|images|human_evidence)"\s*:\s*\[\s*\{/i;
        if(n.locatorRows.some(x=>media.test(canonicalJson([x.row,...Object.entries(x.row).filter(([key,value])=>key.endsWith('_json')&&value!==null&&value!==undefined).map(([,value])=>JSON.parse(String(value)))]))))
            throw new BotError(409,'PREBIND_UNREVIEWED_INVENTORY_MEDIA: complete authorized byte review unavailable');
        const records=retainedEmailLocators(n.locatorRows);
        const response=emailPrebindResponse.parse({
            schemaVersion:'customer-email-prebind-context/v1',execute:false,dispatchEntitlement:false,authority:false,ready:false,
            registration_id:r.id,registration_hash:registrationHash,capability_hash:canonicalSha256(r.prebindCapability),
            observed_at:new Date(observed).toISOString(),expires_at:new Date(Math.min(observed+5000,...[r.expiresAt,r.custodyExpiresAt,r.credentialExpiresAt,r.readbackExpiresAt,r.prebindCapability!.expiresAt].map(Date.parse))).toISOString(),
            input:p,business_id:n.businessId,payload:n.payload,payload_hash:n.payloadHash,source_hash:n.sourceHash,
            context_revision:n.contextRevision,acl_hash:n.aclHash,inventory_hash:n.inventoryHash,records,
            locator_hash:canonicalSha256(records),complete:true,unreviewed_media:[],scope_complete:false,
            scope_blocker:'AUTHENTICATED_SOURCE_CLOSURES_REQUIRED'
        });
        if(Buffer.byteLength(canonicalJson(response))>2000000)throw new BotError(409,'Complete prebind response exceeds bound');
        if(check(io.registration(registrationId))!==registrationHash)throw new BotError(409,'Prebind registration drift');
        if(io.now()<observed||io.now()-observed>5000)throw new BotError(409,'Prebind read exceeded fresh bound');
        return response;
    }).immediate();
}
