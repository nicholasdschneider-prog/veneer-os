import {it,expect} from 'vitest';
import {BOT_TOOL_DEFINITIONS,callBotTool} from '../src/mcp/botTools.js';
it('discovers and routes composed SMS reads without a mutation or duplicated dispatch',async()=>{
 const names=['inspect_composed_sms','derive_composed_sms','read_composed_sms','accept_composed_sms','claim_composed_sms','record_composed_sms_delivery','revoke_composed_sms'];
 for(const name of names)expect(BOT_TOOL_DEFINITIONS.some(t=>t.name===name)).toBe(true);
 const calls:unknown[]=[];
 const callApi=async(...args:unknown[])=>{calls.push(args);return {execute:false};};
 await callBotTool({name:'read_composed_sms',args:{authority_id:'exact-id'},callApi});
 expect(calls).toEqual([['/api/bots/composed-sms/exact-id',undefined]]);
});
