// Synthetic full-app fixture: no real decision, customer, voice or provider requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true,watch:{ignored:['**/dist/**']}}});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/decision-thread-handoffs/',import.meta.url).pathname;await mkdir(output,{recursive:true});
const initial=()=>({id:'fixture-decision',conversation_id:'fixture-bot',version:1,state:'needs_input',source_key:'fixture',proposal_key:'fixture',proposal:{question:'Review reply',recommendation:'Send the factual update.',consequence:'No refund, replacement or delivery promise. Keep unresolved work open.',assignee_id:1,team:'',deadline:null,evidence:[],blocked_action:'Check sources. EXACT DRAFT: Hello, here is the exact factual update.',blocks_scope:'task',review_summary:{action_title:'Send a factual update',customer_request:'The customer wants an update.',background:['The source is being checked.'],refund:{status:'not_verified'}},message_delivery:{canonical_case:'fixture-case',executor_conversation_id:'fixture-bot',payload:{channel:'email',account:'help@example.test',recipients:['customer@example.test'],subject:'Fixture update',body:'Hello, here is the exact factual update.',customer:'fixture-customer',ticket:'fixture-case',context:'No additional action.',attachments:[]}}},answer:null,result:null,parked:null,created_at:'2026-09-24 12:00:00',updated_at:'2026-09-24 12:00:00',can_amend:true,can_edit_reply:true,can_answer:true,dismissed:false,bot_name:'Fixture Avery',assignee_name:'Fixture owner'});
try{
 for(const width of [375,1440])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:1100}});let d=initial();const calls=[],errors=[];let handoffs=[],searches=0,failRefresh=false,lost=true;page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname,method=route.request().method();
   if(p==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'owner@example.test',displayName:'Fixture owner',role:'owner',employeeWorkspace:width===375}}});
   if(p.endsWith('/handoff-targets')){searches++;return route.fulfill({json:{targets:[{id:'target-thread',title:'Purchasing fixture',project:'Fixture workspace'}]}});}
   if(p.endsWith('/handoffs')&&method==='GET')return route.fulfill({json:{handoffs}});
   if(p.endsWith('/handoffs')&&method==='POST'){
    const body=route.request().postDataJSON();calls.push(body);
    handoffs=[{id:'handoff',target_id:'target-thread',target_label:'Purchasing fixture',version:1,delivery_status:'pending',completed_at:null}];
    if(lost){lost=false;return route.abort('failed');}failRefresh=true;return route.fulfill({json:{id:'handoff'}});
   }
   if(p==='/api/bots'&&failRefresh){failRefresh=false;return route.fulfill({status:503,json:{error:'Refresh temporarily unavailable'}});}
   if(p==='/api/bots')return route.fulfill({json:{bots:[],decisions:[d],teams:[]}});
   if(p==='/api/bots/decisions/fixture-decision')return route.fulfill({json:{decision:d,messages:[{id:'m1',actor_name:'Fixture owner',actor_conversation_id:null,text:'Please update the reply from our discussion.',created_at:'2026-09-24 12:00:00'}],events:[]}});
   if(p==='/api/bots/decisions/fixture-decision/reply'&&method==='POST'){
    const body=route.request().postDataJSON();calls.push(body);if(body.expected_version!==d.version)return route.fulfill({status:409,json:{error:'Proposal version changed'}});
    d={...d,version:d.version+1,proposal:{...d.proposal,message_delivery:{...d.proposal.message_delivery,payload:{...d.proposal.message_delivery.payload,body:body.body}},blocked_action:'Check sources. EXACT DRAFT: '+body.body,review_summary:undefined}};
    return route.fulfill({json:{decision:d}});
   }
   if(p.includes('/bot-communication/chats/'))return route.fulfill({json:{drafts:[],briefings:[],approved_obligations:[]}});
   if(p==='/api/team-rooms')return route.fulfill({json:{rooms:[]}});
   if(p==='/api/team-rooms/directory')return route.fulfill({json:{self_key:'user:1',teams:[]}});
   if(p==='/api/navigation')return route.fulfill({json:{configured:true,navigation:{items:[]}}});
   if(p==='/api/page-brand')return route.fulfill({json:{brand:{}}});
   return route.fulfill({status:404,json:{error:'Not in synthetic fixture'}});
  });
  await page.goto('http://127.0.0.1:3297/#/bots/fixture-decision');
  await page.getByRole('region',{name:'Decision thread'}).getByRole('heading',{name:'Send a factual update',exact:true}).waitFor();
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.colorMode=t;},theme);
  const panel=page.getByRole('region',{name:'Decision thread'});
  const composer=panel.getByRole('textbox',{name:'Message Fixture Avery'});
  await composer.fill('@Purch');await page.getByRole('listbox',{name:'Workspace threads'}).getByRole('option').first().waitFor();
  await page.screenshot({path:output+`${width}-${theme}-picker.png`,fullPage:true});
  await composer.press('Escape');assert.equal(await page.getByRole('listbox').count(),0);
  await composer.click();await page.getByRole('listbox',{name:'Workspace threads'}).getByRole('option').first().waitFor();assert(searches>=2);
  await composer.press('ArrowDown');await composer.press('Enter');
  assert.equal(await page.getByRole('listbox').count(),0);
  await composer.fill((await composer.inputValue())+'Investigate the retained evidence and report here.');
  const send=panel.getByRole('button',{name:'Send investigation to Purchasing fixture'});
  await send.click();await panel.getByText(/Failed to fetch|fetch failed|NetworkError/).waitFor();
  assert((await composer.inputValue()).includes('Investigate'));
  await send.click();await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message Fixture Avery"]')?.value==='');
  assert.equal(calls.length,2);assert.equal(calls[0].request_key,calls[1].request_key);assert.equal(calls[1].target_id,'target-thread');
  await panel.getByText('Investigation queued',{exact:false}).waitFor({timeout:12000});
  handoffs=[{...handoffs[0],delivery_status:'delivered',completed_at:'2026-09-24 14:00:00'}];
  await panel.getByText('Findings returned in this discussion',{exact:false}).waitFor({timeout:12000});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await page.screenshot({path:output+`${width}-${theme}.png`,fullPage:true});
  await page.close();
 }
 console.log('Passed synthetic handoff picker keyboard/reopen, lost-response same-key retry, successful-send/failed-refresh clearing, status, mobile/desktop and light/dark. No live actions.');
}finally{await browser.close();await vite.close();}
