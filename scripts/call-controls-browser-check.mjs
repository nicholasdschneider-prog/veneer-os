import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url).pathname;
const vite = await createServer({ root: `${root}web`, server: { host:'127.0.0.1', port:3297, strictPort:true, fs:{allow:[root]} }, plugins:[{
 name:'call-preview', configureServer(server) { server.middlewares.use('/call-preview', async (_req,res) => { res.setHeader('Content-Type','text/html'); res.end(await server.transformIndexHtml('/call-preview', `<html><body><div id="root"></div><script type="module" src="/@fs/${root}scripts/fixtures/call-controls.tsx"></script></body></html>`)); }); }
}] });
await vite.listen();
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const output=`${root}docs/reports/call-controls`;
await mkdir(output,{recursive:true});
try {
 for (const width of [320,375,414,768,1440]) for (const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.route('**/api/**',r=>r.fulfill({status:404,body:'Fixture only'}));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:3297/call-preview');
  await page.locator('h1').waitFor();
  await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.dataset.colorMode=t},theme);
  const call=page.getByRole('button',{name:'Talk with fixture bot',exact:true});
  await call.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('body').getAttribute('data-calls'),'1');
  for (const button of await page.locator('button:has(svg.lucide-audio-lines)').all()) {
   const box=await button.boundingBox();assert(box.width>=44&&box.height>=44, JSON.stringify({name:await button.innerText(),box}));
  }
  assert(await page.getByRole('button',{name:'Unavailable call'}).isDisabled());
  assert.equal(await page.locator('svg.lucide-phone').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
  if ([375,1440].includes(width)) await page.screenshot({path:`${output}/${width}-${theme}.png`,fullPage:true});
  await page.close();
 }
 console.log('Call controls passed: five widths, both themes, shared waveform, touch targets, keyboard activation, disabled state, no overflow. No live calls.');
} finally { await browser.close();await vite.close(); }
