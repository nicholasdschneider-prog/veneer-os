// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {TeamMessages} from '/src/screens/TeamMessages.tsx';
import '/src/styles.css';
const h=React.createElement;function Fixture(){const [hash,setHash]=React.useState('#/messages/fixture');return h('main',{style:{height:'100dvh'}},h(TeamMessages,{roomId:hash.split('/')[2],onNavigate:setHash}));}ReactDOM.createRoot(document.getElementById('root')).render(h(Fixture));`;
const vite = await createServer({
  root: new URL("../web", import.meta.url).pathname,
  server: {
    host: "127.0.0.1",
    port: 3299,
    strictPort: true,
    preTransformRequests: false,
  },
  plugins: [
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use("/__fixture", async (req, res) => {
          res.setHeader(
            "Content-Type",
            req.url?.includes("entry") ? "application/javascript" : "text/html",
          );
          res.end(
            req.url?.includes("entry")
              ? source
              : await s.transformIndexHtml(
                  "/__fixture",
                  '<html data-color-mode="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fixture/entry"></script></body></html>',
                ),
          );
        });
      },
    },
  ],
});
await vite.listen();
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const output = process.argv[3] ?? new URL("../docs/reports/team-enter/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try{for(const touch of [false,true]){
 const page=await browser.newPage({viewport:{width:touch?375:1280,height:900},hasTouch:touch});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));let sends=[],fail=false,hold=false,release;
 const room={id:'fixture',kind:'group',team_id:'team',name:'Fixture Team',revision:1,last_seq:0,members:[{key:'user:1',name:'Alex',kind:'human'},{key:'bot:helper',name:'Helper',kind:'bot'}],self_key:'user:1',can_send:true,can_manage:true,messages:[],next:null,unread:0};
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let body={};if(p.endsWith('/messages')){sends.push(route.request().postDataJSON());if(hold)await new Promise(r=>release=r);if(fail){fail=false;return route.fulfill({status:503,json:{error:'Fixture send failed'}});}body={id:'sent'};}else if(p==='/api/team-rooms')body={rooms:[room]};else if(p.endsWith('/directory'))body={self_key:'user:1',teams:[]};else if(p==='/api/bots')body={bots:[],teams:[]};else if(p==='/api/huddles')body={huddles:[]};else if(p.includes('/organization'))body={revision:0,groups:[],placements:{},fallback:null};else body={room};await route.fulfill({json:body});});
 await page.goto('http://127.0.0.1:3299/__fixture');const input=page.getByRole('textbox',{name:'Message',exact:true});await input.waitFor();await input.fill('First');await input.press('Shift+Enter');assert.equal(await input.inputValue(),'First\n');assert.equal(sends.length,0);
 await input.fill('Composition');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229});assert.equal(sends.length,0);
 await input.fill('Hello');await input.press('Enter');if(touch){assert.equal(sends.length,0);assert.equal(await input.inputValue(),'Hello\n');await input.press('Control+Enter');}await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]').value==='');assert.equal(sends.length,1);
 await input.fill('Repeat');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',repeat:true});assert.equal(sends.length,1);
 await input.fill('@Helper');await input.press(touch?'Control+Enter':'Enter');assert.equal(sends.length,1);assert.equal(await page.getByRole('button',{name:'@Helper · Bot',exact:true}).evaluate(e=>document.activeElement===e),true);await page.keyboard.press('Enter');await input.press(touch?'Control+Enter':'Enter');await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]').value==='');assert.deepEqual(sends[1].mentions,['bot:helper']);
 fail=true;await input.fill('Retry me');await input.press('Control+Enter');await page.getByText('Fixture send failed',{exact:true}).waitFor();assert.equal(await input.inputValue(),'Retry me');const key=sends.at(-1).request_key;await input.press('Meta+Enter');await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]').value==='');assert.equal(sends.at(-1).request_key,key);
 hold=true;await input.fill('Only once');const before=sends.length;await input.press('Control+Enter');await page.waitForTimeout(100);await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',ctrlKey:true});assert.equal(sends.length,before+1);release();hold=false;await page.waitForFunction(()=>!document.querySelector('textarea[aria-label="Message"]').disabled);await input.press('Control+Enter');assert.equal(sends.length,before+1);
 await page.screenshot({path:output+(touch?'mobile':'desktop')+'.png'});assert.deepEqual(errors,[]);await page.close();console.log('PASS',touch?'touch':'desktop');
}}finally{await browser.close();await vite.close();}
