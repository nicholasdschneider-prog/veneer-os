// Isolated fixtures only: never contacts teammates, providers, or business systems.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const source = `import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';import {BotProposalSummary} from '/src/components/BotProposalSummary.tsx';import '/src/styles.css';const decision={id:'fixture',version:1,proposal:{recommendation:'Send this exact fixture explanation.',consequence:'One email only. No repeat refund or other financial action.',blocked_action:'Existing source checks and RUNNING lifecycle still required.',message_delivery:{canonical_case:'fixture-case',executor_conversation_id:'fixture-nora',payload:{channel:'email',account:'Fixture support account',recipients:['customer@example.test'],subject:'Fixture explanation',body:'Hello,\\n\\nThis is an exact approved fixture message. No real customer will be contacted.',customer:'Fixture customer',ticket:'fixture-case',context:'Fixture context retained.',attachments:[{name:'context.pdf',reference:'fixture-case/retained-context',sha256:'a'.repeat(64)}]}}}};ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto max-w-2xl p-4'},React.createElement('h1',{className:'mb-4 text-xl font-semibold'},'Needs input · fixture'),React.createElement(BotProposalSummary,{decision,showIdentifiers:true})));`;

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
const output = new URL("../docs/reports/approved-message-delegation/", import.meta.url)
  .pathname;
await mkdir(output, { recursive: true });
try {for(const width of [320,375,768,1440])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height:1100},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/**',route=>route.abort());
 await page.goto('http://127.0.0.1:3299/__fixture');await page.evaluate(t=>document.documentElement.setAttribute('data-color-mode',t),theme);
 await page.getByRole('heading',{name:'Exact customer message to authorize'}).waitFor();
 for(const text of ['Fixture support account','customer@example.test','fixture-case','fixture-nora','context.pdf','a'.repeat(64)])assert(await page.getByText(text,{exact:false}).first().isVisible());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);await page.screenshot({path:output+`scope-${width}-${theme}.png`,fullPage:true});await page.close();console.log('PASS',width,theme);
 }}finally{await browser.close();await vite.close();}
