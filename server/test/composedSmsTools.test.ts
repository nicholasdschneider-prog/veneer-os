import {it,expect} from 'vitest';
import {BOT_TOOL_DEFINITIONS,callBotTool} from '../src/mcp/botTools.js';
it('discovers and routes composed SMS reads without a mutation or duplicated dispatch',async()=>{
 const names=['inspect_composed_sms_scope','record_composed_sms_scope','revoke_composed_sms_scope','inspect_composed_sms','derive_composed_sms','read_composed_sms','accept_composed_sms','claim_composed_sms','record_composed_sms_delivery','revoke_composed_sms'];
 for(const name of names)expect(BOT_TOOL_DEFINITIONS.some(t=>t.name===name)).toBe(true);
 const calls:unknown[]=[];
 const callApi=async(...args:unknown[])=>{calls.push(args);return {execute:false};};
 await callBotTool({name:'read_composed_sms',args:{authority_id:'exact-id'},callApi});
 expect(calls).toEqual([['/api/bots/composed-sms/exact-id',undefined]]);
});
it('advertises reservation only and source receipt reconciliation without accepting a bot SID',()=>{
 const claim=BOT_TOOL_DEFINITIONS.find(t=>t.name==='claim_composed_sms')!;
 const receipt=BOT_TOOL_DEFINITIONS.find(t=>t.name==='record_composed_sms_delivery')!;
 expect(claim.description).toContain('execute:false');expect(receipt.description).toContain('server fetches');
 expect(JSON.stringify(receipt)).not.toContain('delivery_proof');
});

it('routes scope review tools without turning classification into send',async()=>{const calls:unknown[]=[];await callBotTool({name:'inspect_composed_sms_scope',args:{authority_id:'exact'},callApi:async(...args:unknown[])=>{calls.push(args);return {execute:false};}});expect(calls).toEqual([['/api/bots/composed-sms/exact/scope/inspect',{method:'POST',body:'{}'}]]);});

it('exposes exact correction inspection and derivation without importing evidence or replacing old tools',async()=>{
 for(const name of ['inspect_composed_sms_correction','derive_composed_sms_correction'])expect(BOT_TOOL_DEFINITIONS.some(t=>t.name===name)).toBe(true);
 const calls:unknown[]=[];await callBotTool({name:'inspect_composed_sms_correction',args:{source_id:'original',correction_source_id:'correction'},callApi:async(...args:unknown[])=>{calls.push(args);return {execute:false};}});
 expect(calls).toEqual([['/api/bots/composed-sms/corrections/inspect',{method:'POST',body:JSON.stringify({source_id:'original',correction_source_id:'correction'})}]]);
});

it('routes draft-free preflight and read-only semantic review separately from derive',async()=>{
 for(const [name,suffix] of [['inspect_correction_preflight','inspect'],['review_correction_preflight','review']]){
  const tool=BOT_TOOL_DEFINITIONS.find(t=>t.name===name)!;expect(tool).toBeTruthy();expect(JSON.stringify(tool.inputSchema)).not.toContain('draft_id');
  const calls:unknown[]=[];await callBotTool({name:name!,args:{decision_id:'d'},callApi:async(...args:unknown[])=>{calls.push(args);return {execute:false};}});
  expect(calls).toEqual([['/api/bots/composed-sms/correction-preflight/'+suffix,{method:'POST',body:'{"decision_id":"d"}'}]]);
 }
});
it('routes integrated v2 review input without replacing historical tools',async()=>{
 for(const [name,path] of [['inspect_composed_sms_correction_v2','inspect'],['derive_composed_sms_correction_v2','derive'],['read_composed_sms_correction_v2','reconcile']]){
  const tool=BOT_TOOL_DEFINITIONS.find(t=>t.name===name)!;expect(tool).toBeTruthy();if(path==='derive'){expect(JSON.stringify(tool.inputSchema)).toContain('context_review');expect(JSON.stringify(tool.inputSchema)).toContain('continuity');}
  const calls:unknown[]=[];await callBotTool({name:name!,args:{decision_id:'d'},callApi:async(...args:unknown[])=>{calls.push(args);return {execute:false};}});expect(calls).toEqual([['/api/bots/composed-sms/corrections-v2/'+path,{method:'POST',body:'{"decision_id":"d"}'}]]);
 }
});
