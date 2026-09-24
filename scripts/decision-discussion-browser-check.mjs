// Synthetic full-app fixture: no real decision, customer, voice or provider requests.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3296,strictPort:true}});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/decision-discussion/',import.meta.url).pathname;await mkdir(output,{recursive:true});
const initial=()=>({id:'fixture-decision',conversation_id:'fixture-bot',version:1,state:'needs_input',source_key:'fixture',proposal_key:'fixture',proposal:{question:'Review reply',recommendation:'Send the factual update.',consequence:'No refund, replacement or delivery promise. Keep unresolved work open.',assignee_id:1,team:'',deadline:null,evidence:[],blocked_action:'Check sources. EXACT DRAFT: Hello, here is the exact factual update.',blocks_scope:'task',review_summary:{action_title:'Send a factual update',customer_request:'The customer wants an update.',background:['The source is being checked.'],refund:{status:'not_verified'}},message_delivery:{canonical_case:'fixture-case',executor_conversation_id:'fixture-bot',payload:{channel:'email',account:'help@example.test',recipients:['customer@example.test'],subject:'Fixture update',body:'Hello, here is the exact factual update.',customer:'fixture-customer',ticket:'fixture-case',context:'No additional action.',attachments:[]}}},answer:null,result:null,parked:null,created_at:'2026-09-24 12:00:00',updated_at:'2026-09-24 12:00:00',can_amend:true,can_edit_reply:true,can_answer:true,dismissed:false,bot_name:'Fixture Avery',assignee_name:'Fixture owner'});
try{
 for(const width of [320,375,414,768,1440])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:1100}});let d=initial();const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname,method=route.request().method();
   if(p==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'owner@example.test',displayName:'Fixture owner',role:'owner',employeeWorkspace:false}}});
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
  await page.goto('http://127.0.0.1:3296/#/bots/fixture-decision');
  await page.getByRole('region',{name:'Decision thread'}).getByRole('heading',{name:'Send a factual update',exact:true}).waitFor();
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.colorMode=t;},theme);
  const panel=page.getByRole('region',{name:'Decision thread'});
  const technical=panel.locator('details').filter({has:page.locator('summary',{hasText:'Details, evidence & history'})});
  assert.equal(await technical.getAttribute('open'),null);
  assert(!(await panel.getByText('Original details & conditions',{exact:true}).isVisible()));
  const discussion=page.getByRole('heading',{name:'Discussion with Fixture Avery'});assert(await discussion.isVisible());
  const summary=technical.locator('summary').first();await summary.focus();await page.keyboard.press('Enter');assert(await panel.getByText('Original details & conditions',{exact:true}).isVisible());await summary.click();
  await panel.getByRole('button',{name:'Edit customer reply',exact:true}).click();
  const editor=panel.getByRole('textbox',{name:/Edit customer reply/});await editor.fill('My exact edited reply. Keep the caveat.');
  assert(await panel.getByRole('button',{name:/Approve recommendation/}).isDisabled());
  await panel.getByRole('button',{name:'Save reply for review'}).click();await page.getByText('Current recommendation · v2.',{exact:false}).waitFor();
  assert.equal(calls.length,1);assert.equal(calls[0].body,'My exact edited reply. Keep the caveat.');assert.equal(calls[0].expected_version,1);
  await panel.getByRole('button',{name:'Edit customer reply',exact:true}).click();await editor.fill('Unsaved text survives polling');
  d={...d,version:3,proposal:{...d.proposal,message_delivery:{...d.proposal.message_delivery,payload:{...d.proposal.message_delivery.payload,body:'Bot revised reply'}}}};
  await panel.getByText('This proposal has changed.',{exact:false}).waitFor({timeout:12000});assert.equal(await editor.inputValue(),'Unsaved text survives polling');
  await panel.getByRole('button',{name:'Cancel edit'}).click();
  // Next clean poll adopts the new version without another approval or mutation.
  await page.getByText('Current recommendation · v3.',{exact:false}).waitFor({timeout:12000});
  assert(await panel.getByText('Bot revised reply',{exact:true}).isVisible());assert.equal(calls.length,1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  if([375,1440].includes(width))await page.screenshot({path:output+`${width}-${theme}.png`,fullPage:true});
  await page.close();
 }
 console.log('Passed full-app collapsed details, keyboard/tap, discussion, exact reply save, approval disabled while editing, stale polling protection/clean refresh, five widths/both themes. No live actions.');
}finally{await browser.close();await vite.close();}
