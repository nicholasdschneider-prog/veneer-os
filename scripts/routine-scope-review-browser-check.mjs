// Isolated full-app fixtures. No owner enrollment, source lookup or customer effects.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true}});await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/routine-scope-handoff/screenshots/',import.meta.url).pathname;await mkdir(output,{recursive:true});
const caseId='20000000-0000-4000-8000-000000000002',customer='30000000-0000-4000-8000-000000000003';
const tuple={decision_id:'fixture-decision',decision_version:1,proposal_hash:'a'.repeat(64),event_revision:7};
const fresh=()=>({...tuple,proposal:{question:'Hold the fixture replacement until its photos are reviewed.'},handoff:null,binding:null,binding_revoked:false,evidence:null});
try{
 for(const width of [375,1440])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:1000}});let review=fresh(),posts=0,deny=false,blocked=false;const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'owner@fixture.test',role:'owner'}}});
   if(p==='/api/bot-communication/routine-messages/setup')return route.fulfill({status:deny?403:200,json:deny?{error:'Current business owner required'}:{status:blocked?'blocked':'registered',receipt:blocked?null:{trust_id:'fixture-trust'}}});
   if(p.endsWith('/hold-scopes/list'))return route.fulfill({json:{records:[{...tuple,state:'blocked'}],total_count:1,unavailable_count:0}});
   if(p.endsWith('/hold-scopes/review'))return route.fulfill({json:review});
   if(p.endsWith('/hold-scopes/handoffs')){
    const body=route.request().postDataJSON();posts++;assert.equal(body.trust_id,'fixture-trust');assert.equal(body.confirmation,'source-locators-only-not-scope-classification');assert.equal(body.expected_handoff_id,null);assert.equal(body.event_revision,7);assert.deepEqual(body.roots,[{canonical_case:caseId,source_reference:'https://source.example.test/api/cs/conversations/'+caseId}]);
    review.handoff={handoff_id:'fixture-handoff',revision:1,status:'current',source_origin:'https://source.example.test',source_request:{requestKey:'60000000-0000-4000-8000-000000000006',roots:[caseId],decision:{id:tuple.decision_id,version:1,proposal_hash:tuple.proposal_hash,event_revision:7}}};
    return route.abort('failed'); // Native persisted, response lost. UI must read, not retry.
   }
   if(p.endsWith('/hold-scopes/bind')){
    posts++;const body=route.request().postDataJSON();assert.equal(body.scope_kind,'case_set');assert.equal(body.evidence_id,'fixture-evidence');assert.equal(body.confirmation,'complete-current-scope-not-business-approval');
    review.binding={id:'fixture-binding',scope_kind:'case_set'};return route.fulfill({json:{binding_id:'fixture-binding',execute:false}});
   }
   if(p.endsWith('/handoffs/revoke')){posts++;review.handoff.status='unavailable';if(review.evidence)review.evidence.handoff_current=false;return route.fulfill({json:{revoked:true,execute:false}});}
   if(p==='/api/navigation')return route.fulfill({json:{configured:true,navigation:{items:[]}}});
   if(p==='/api/page-brand')return route.fulfill({json:{brand:{}}});
   return route.fulfill({status:404,json:{error:'Not a fixture endpoint'}});
  });
  await page.goto('http://127.0.0.1:3297/#/routine-scope-review');await page.getByLabel('Decision to review').selectOption('fixture-decision');
  const refresh=page.getByRole('button',{name:'Refresh selected decision'});await refresh.click();await page.getByRole('heading',{name:/Original decision/}).waitFor();assert.equal(posts,0);
  await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
  await page.getByLabel('Source case ID 1',{exact:true}).fill(caseId);await page.getByLabel('Source record link 1',{exact:true}).fill('https://source.example.test/api/cs/conversations/'+caseId);
  await page.getByRole('button',{name:'Prepare case handoff'}).click();await page.getByRole('alert').waitFor();assert.equal(posts,1);assert.equal(await page.getByRole('button',{name:'Prepare case handoff'}).isDisabled(),true);
  await refresh.click();await page.getByLabel('Handoff reference').waitFor();assert.equal(posts,1);assert.equal(await page.getByLabel('Handoff reference').inputValue(),'fixture-handoff');assert.deepEqual(JSON.parse(await page.getByLabel('Exact source lookup request').inputValue()),review.handoff.source_request);
  review.evidence={id:'fixture-evidence',fresh:false,handoff_current:true,snapshot:{source_revision:'source-revision-1',captured_at:'2026-09-25T18:00:00Z',cases:[{canonical_case:caseId,ticket:'FIXTURE',customer_id:customer,customer_alias_ids:[],orders:[],source_reference:'cs_conversations/'+caseId}]}};
  await refresh.click();await page.getByText('FIXTURE',{exact:true}).waitFor();await page.getByLabel('Scope of the original decision').selectOption('case_set');await page.getByLabel('Evidence supporting your scope review').fill('Original fixture decision and complete source projection reviewed.');
  const classify=page.getByRole('button',{name:'Record scope classification'});assert.equal(await classify.isDisabled(),true);await page.getByRole('checkbox').check();
  await page.screenshot({path:output+`${width}-${theme}.png`,fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await classify.click();await page.getByText('Recorded. Refresh the selected decision',{exact:false}).waitFor();await refresh.click();await page.getByText('Recorded scope: case_set.',{exact:true}).waitFor();assert.equal(posts,2);
  await page.getByRole('button',{name:'Revoke case handoff'}).click();await page.getByText('Recorded. Refresh the selected decision',{exact:false}).waitFor();await refresh.click();await page.getByText('Handoff revision 1: unavailable.',{exact:false}).waitFor();assert.equal(await page.getByLabel('Exact source lookup request').count(),0);assert.equal(posts,3);
  deny=true;await page.reload();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'Prepare case handoff'}).count(),0);
  deny=false;blocked=true;await page.reload();await page.getByText('Complete the',{exact:false}).waitFor();assert.equal(await page.getByLabel('Decision to review').count(),0);assert.equal(posts,3);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Passed owner scope review: desktop/mobile light/dark, exact immutable handoff, lost-response read-only recovery, projection review, explicit classification, revocation, owner/setup denial, no automatic mutations and no overflow. Synthetic only.');
}finally{await browser.close();await vite.close();}
