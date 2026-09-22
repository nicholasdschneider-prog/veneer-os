import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {sendBotEvent} from './bot-event-sender.mjs';
const event={id:'fixture-event',type:'connection.test',ticket_id:'connection-test',occurred_at:'2026-09-22T00:00:00Z'};
test('signs the exact body, refuses redirects, and accepts a durable receipt',async()=>{
 const secret='test-only-signing-fixture';
 const result=await sendBotEvent({url:'https://example.test/webhooks/bot-events/source',secret,event,fetchImpl:async(url,options)=>{
 assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),event);
 assert.equal(options.headers['X-Veneer-Signature'],createHmac('sha256',secret).update(options.headers['X-Veneer-Timestamp']+'.'+options.body).digest('hex'));
 return new Response(JSON.stringify({ok:true,queued:0}));
 }});assert.deepEqual(result,{queued:0});
});
test('rejected deliveries and invalid receipts remain failures for outbox retry',async()=>{
 for(const response of [new Response('',{status:503}),new Response(JSON.stringify({ok:true}))]){
 await assert.rejects(sendBotEvent({url:'https://example.test/webhooks/bot-events/source',secret:'fixture',event,fetchImpl:async()=>response}));
 }
});
test('refuses non-TLS and credential-bearing destinations before reading the network',async()=>{
 for(const url of ['http://example.test/webhooks/bot-events/source','https://user:password@example.test/webhooks/bot-events/source']){
 await assert.rejects(sendBotEvent({url,secret:'fixture',event,fetchImpl:async()=>{throw new Error('must not fetch');}}),/HTTPS/);
 }
});
