import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url).pathname;
const vite = await createServer({ root: `${root}web`, server: { host:'127.0.0.1', port:3296, strictPort:true, fs:{allow:[root]} }, plugins:[{
 name:'decision-preview', configureServer(server) { server.middlewares.use('/decision-preview', async (_req,res) => { res.setHeader('Content-Type','text/html'); res.end(await server.transformIndexHtml('/decision-preview', `<html><body><div id="root"></div><script type="module" src="/@fs/${root}scripts/fixtures/cs-drafts.tsx"></script></body></html>`)); }); }
}] });
await vite.listen();
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=`${root}docs/reports/cs-draft-follow-through`;
await mkdir(output,{recursive:true});
try {
 for (const width of [320,375,414,768,1440]) for (const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.route('**/api/**',r=>r.fulfill({status:404,body:'Fixture only'}));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3296/decision-preview');
  await page.getByRole('article').first().waitFor();
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.colorMode=t},theme);
  const cards=page.getByRole('article');
  assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).count(),1);
  assert.equal(await page.getByRole('link',{name:'Open central work overview'}).count(),8);
  assert.equal(await cards.first().getByRole('button',{name:'Send message',exact:true}).count(),0);
  await page.getByRole('link',{name:'Open central work overview'}).first().focus();
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Open central work overview');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  if ([375,1440].includes(width)) await page.screenshot({path:`${output}/${width}-${theme}.png`,fullPage:true});
  await page.close();
 }
 console.log('CS drafts passed five widths/both themes: central links, lifecycle visibility, no CS Send CTA, ordinary Send retained, keyboard and overflow. Fixtures only.');
} finally { await browser.close();await vite.close(); }
