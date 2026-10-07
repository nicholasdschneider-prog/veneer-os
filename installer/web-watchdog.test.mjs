import assert from 'node:assert/strict';
import test from 'node:test';
import { renderWatchdog, WATCHDOG_LABEL } from './web-watchdog.mjs';
import { reloadLaunchdServices } from './launchd-reload.mjs';
test('scoped watchdog installation renders no credentials and reloads only its own job', async () => {
  const xml=renderWatchdog({node:'/node24',codeDir:'/code & files',dataDir:'/data',port:3100,logDir:'/logs',serviceHome:'/service'});
  assert.match(xml,/\/code &amp; files\/server\/dist\/ops\/webWatchdogMain.js/);
  assert.match(xml,/<string>3100<\/string>/);assert.doesNotMatch(xml,/__[A-Z_]+__/);
  assert.throws(()=>renderWatchdog({port:0}),/port/);
  const calls=[];
  const result=await reloadLaunchdServices({uid:501,services:[{label:WATCHDOG_LABEL,plist:'/watchdog.plist'}],launchctl:(args)=>{
    calls.push(args);
    if(args[0]==='print'&&calls.filter(c=>c[0]==='bootstrap').length===0) throw new Error('not loaded');
    return '';
  },wait:async()=>{},log:()=>{}});
  assert.equal(result.ok,true);
  assert.equal(calls.some(c=>c.some(v=>v.includes('com.veneer.pro.runner'))),false);
  assert.equal(calls.filter(c=>c[0]==='bootstrap').length,1);
});
