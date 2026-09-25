// Isolated local fixture; no production accounts, decisions, or messages.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {QuestionCard} from '/src/components/chat/QuestionCard.tsx';
import {DecisionChoices} from '/src/components/DecisionChoices.tsx';
import '/src/styles.css';
const h=React.createElement,root=ReactDOM.createRoot(document.getElementById('root'));
window.show=(count=2,multi=false,status='pending',answers={})=>{
 const options=Array.from({length:count},(_,i)=>({label:count===2?(i?'No':'Yes'):'Option '+(i+1),value:'option-'+i,description:'Example choice '+(i+1)}));
 root.render(h('main',{className:'mx-auto h-dvh max-w-xl overflow-y-auto p-4 space-y-5'},
 h(QuestionCard,{key:count+'-'+multi,item:{kind:'question',key:'fixture',requestId:'fixture',questions:[{id:'q1',question:'Which option would you like?',options,multi,allowOther:false}],status,answers}}),
 h('section',{'aria-label':'Decision choices'},h('h2',null,'Example decision'),h(DecisionChoices,{choices:options.map((o,i)=>({id:o.value,label:o.label,action:i?'defer':'approve'})),disabled:status!=='pending',onChoose:id=>{window.decisionChoice=id}}))));
};window.show();`;
const vite = await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true,preTransformRequests:false},plugins:[{
 name:'question-fixture',configureServer(server){server.middlewares.use('/__fixture',async(req,res)=>{
 res.setHeader('Content-Type',req.url?.includes('entry')?'application/javascript':'text/html');
 res.end(req.url?.includes('entry')?source:await server.transformIndexHtml('/__fixture','<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>'));
 });}
}]});
await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=new URL('../docs/reports/question-cards/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
try {
 for(const width of [320,390,1280]){
  const page=await browser.newPage({viewport:{width,height:900}}), errors=[], submissions=[];
  page.setDefaultTimeout(10_000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   assert.match(new URL(route.request().url()).pathname,/\/questions\/fixture\/resolve$/);
   submissions.push(route.request().postDataJSON());
   await route.fulfill({json:{ok:true}});
  });
  await page.goto('http://127.0.0.1:3297/__fixture');
  const submit=page.getByRole('button',{name:'Submit answer',exact:true});
  assert(await submit.isDisabled());
  await page.getByRole('radio').first().focus();
  await page.keyboard.press('Space');
  assert.equal(submissions.length,0);
  await Promise.all([page.waitForResponse('**/questions/fixture/resolve'), submit.click()]);
  assert.deepEqual(submissions,[{answers:{q1:['option-0']}}]);
  assert(await submit.isDisabled());
  await page.evaluate(()=>window.show(2,false,'answered',{q1:['option-0']}));
  await page.getByText('Answered',{exact:true}).waitFor();
  assert.equal(await page.getByRole('radio').count(),0);
  await page.evaluate(()=>window.show(32,true));
  await page.getByRole('checkbox').last().waitFor();
  assert.equal(await page.getByRole('checkbox').count(),32);
  const decisions=page.getByRole('region',{name:'Decision choices'});
  assert.equal(await decisions.getByRole('button').count(),32);
  await decisions.getByRole('button').last().click();
  assert.equal(await page.evaluate(()=>window.decisionChoice),'option-31');
  for(const label of await page.locator('label').filter({has:page.getByRole('checkbox')}).all()) await label.click();
  await Promise.all([page.waitForResponse('**/questions/fixture/resolve'), page.getByRole('button',{name:'Submit answers',exact:true}).click()]);
  assert.equal(submissions[1].answers.q1.length,32);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>window.show(4,false));
  await page.getByRole('radio').last().waitFor();
  if(width!==320) await page.screenshot({path:output+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Question cards passed: 2/4/32 options, mobile/desktop, keyboard selection, explicit submission, duplicate disabling, recorded answer, multi-answer payload, decision choice IDs, and overflow.');
}finally{await browser.close();await vite.close();}
