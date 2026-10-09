// Isolated fixture: every API request is intercepted; no live tasks or provider calls.
// node --import tsx scripts/spare-allowance-browser-check.mjs /absolute/path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {botFeatureCatalog} from '../server/src/featureGuide/catalog.ts';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const output=new URL('../docs/reports/spare-allowance/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const vite=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:3297,strictPort:true}});
await vite.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const errors=[];
try{
  for(const mobile of [false,true]){
    const context=await browser.newContext({viewport:{width:mobile?390:1280,height:900}});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    let guideMode=false;
    const state={settings:{enabled:1},tasks:[],runs:[],accounts:[{provider:'codex',account_id:'spare',reason:'Outside final six hours',checked_at:'2026-10-09T20:00:00Z',snapshot_json:'{}'}],conversations:[{id:'piper',title:'Piper Content',provider:'codex',model:'gpt-test'}],connectedAccounts:[{provider:'codex',id:'spare',label:'Example subscription'}]};
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());const method=route.request().method();
      if(url.pathname==='/api/me')return route.fulfill({json:{setupRequired:false,pending:false,user:{id:1,email:'owner@example.test',displayName:'Owner',role:guideMode&&mobile?'member':'owner',employeeWorkspace:guideMode&&mobile}}});
      if(url.pathname==='/api/usage') {const empty={connected:false,windows:[],planType:null,capturedAt:null,source:null,error:null};return route.fulfill({json:{providers:{claude:empty,codex:empty,grok:empty},openrouter:{configured:false}}});}
      if(url.pathname==='/api/team-rooms')return route.fulfill({json:{rooms:[]}});
      if(url.pathname==='/api/bots')return route.fulfill({json:{bots:[],decisions:[],teams:[]}});
      if(url.pathname==='/api/navigation')return route.fulfill({json:{configured:true,navigation:{items:[]}}});
      if(url.pathname==='/api/page-brand')return route.fulfill({json:{brand:{}}});
      if(url.pathname==='/api/bot-workflows/guide')return route.fulfill({json:botFeatureCatalog(Date.parse('2026-10-09T22:00:00Z'))});
      if(url.pathname==='/api/spare-allowance'&&method==='GET')return route.fulfill({json:state});
      if(url.pathname==='/api/spare-allowance/settings'){state.settings.enabled=Number(route.request().postDataJSON().enabled);return route.fulfill({json:{ok:true}});}
      if(url.pathname==='/api/spare-allowance/tasks'){
        const body=route.request().postDataJSON();assert.equal(body.conversation_id,'piper');assert.deepEqual(body.account_ids,['spare']);
        state.tasks.push({id:'fixture-task',title:body.title,output:body.output,status:'ready',completed_batches:0,max_batches:body.max_batches,conversation_id:body.conversation_id});return route.fulfill({json:{task:state.tasks[0]}});
      }
      if(url.pathname==='/api/spare-allowance/tasks/fixture-task'){state.tasks[0].status=route.request().postDataJSON().status;return route.fulfill({json:{ok:true}});}
      return route.fulfill({status:404,json:{error:'Fixture only'}});
    });
    await page.goto('http://127.0.0.1:3297/#/settings/usage');
    await page.getByRole('button',{name:'Pause all',exact:true}).click();
    await page.getByRole('button',{name:'Enable queue',exact:true}).waitFor();
    await page.getByRole('button',{name:'Enable queue',exact:true}).click();
    await page.getByRole('button',{name:'Add optional task',exact:true}).click();
    await page.getByLabel('Original bot or project chat').selectOption('piper');
    await page.getByLabel('Example subscription').check();
    await page.getByLabel('Task name').fill('Tank gallery drafts');
    await page.getByLabel('Required deliverable').fill('Six accurate gallery images and a saved Blender scene');
    await page.getByLabel('Instructions and source references').fill('Use verified manufacturer dimensions; flag missing geometry.');
    await page.getByLabel('Maximum batches').fill('3');
    await page.getByRole('button',{name:'Save task',exact:true}).click();
    await page.getByRole('button',{name:'Pause task',exact:true}).click();
    await page.getByRole('button',{name:'Resume task',exact:true}).waitFor();
    await page.getByText('Account eligibility and recent results',{exact:true}).click();
    await page.getByText('Example subscription: Outside final six hours',{exact:false}).waitFor();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No horizontal overflow');
    await page.screenshot({path:output+(mobile?'mobile.png':'desktop.png'),fullPage:true});
    guideMode=true;
    await page.goto('http://127.0.0.1:3297/#/bot-guide?feature=spare-allowance');
    await page.reload();
    await page.getByLabel('Search the bot guide').fill('subscription allowance');
    const feature=page.locator('#feature-spare-allowance');await feature.waitFor();
    assert((await feature.innerText()).includes('Only original active owner-accessible chats'));
    await page.screenshot({path:output+(mobile?'guide-mobile.png':'guide-desktop.png'),fullPage:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log('Spare allowance desktop/mobile checks passed: add, account choice, pause/resume, global pause, eligibility, guide discovery, and overflow.');
}finally{await browser.close();await vite.close();}
