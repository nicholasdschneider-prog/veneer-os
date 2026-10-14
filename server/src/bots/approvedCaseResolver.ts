import { z } from 'zod';

const id=z.string().trim().min(1).max(200);
const uuid=z.string().uuid();
const segment=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const approvedCaseRegistrySchema=z.object({schema_version:z.literal('approved-case-registry/v1'),registrations:z.array(z.object({
 id,active:z.boolean(),business_id:uuid,business_owner_user_id:z.number().int().positive(),account_id:id,
 // This integration is specifically the reviewed OrderOps deployment, not an SSRF proxy.
 source_origin:z.literal('https://orderops-dev-web-production.up.railway.app'),
 runtime:z.object({projectId:uuid,environmentId:uuid,serviceId:uuid}).strict(),
 payload_accounts:z.array(id).min(1).max(20),expires_at:z.string().datetime(),
 provenance:z.object({custodian_id:uuid,receipt:id,registered_at:z.string().datetime(),authority:z.literal('approved-message-resolver-custody')}).strict(),
 callers:z.array(z.object({conversation_id:uuid,user_id:z.number().int().positive(),principal_id:id,
 credential:z.object({project:segment,config:segment,name:z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/)}).strict()}).strict()).min(1).max(100),
}).strict()).max(30)}).strict();
export async function boundedResolverGet(url:string,bearer:string,signal:AbortSignal):Promise<unknown>{
 const response=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${bearer}`,Accept:'application/json'},redirect:'error',signal,cache:'no-store'});
 if(!response.ok||!response.body){await response.body?.cancel();throw new Error('Source unavailable');}
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024)throw new Error('Response exceeds bound');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>{});}
}
