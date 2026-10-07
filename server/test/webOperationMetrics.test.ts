import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createWebOperationMetrics, readWebOperations, sanitizeWebOperations, WEB_OPERATION_PHASES } from '../src/ops/webOperationMetrics.js';
import { startWebLoopMetrics } from '../src/ops/webLoopMetrics.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const clock={wall:1000000,mono:0};
  const metrics=createWebOperationMetrics({wall:()=>clock.wall,monotonic:()=>clock.mono});
  return {clock,metrics};
}

it('measures synchronous work without changing results or retrying failures', () => {
  const {clock,metrics}=fixture();
  const result={private:'not telemetry'};
  expect(metrics.measure('routines',()=>{clock.mono+=99;return result;})).toBe(result);
  expect(metrics.snapshot()).toEqual([]);
  expect(metrics.measure('question_rechecks',()=>{clock.mono+=150;return result;})).toBe(result);
  const error=Object.assign(new Error('private SQL and transcript'),{code:'SQLITE_BUSY_SNAPSHOT'});
  let attempts=0;
  expect(()=>metrics.measure('routines',()=>{attempts++;throw error;})).toThrow(error);
  expect(attempts).toBe(1);
  expect(metrics.snapshot()).toEqual([
    {at:clock.wall,phase:'question_rechecks',kind:'sync',ms:150,failure:'none'},
    {at:clock.wall,phase:'routines',kind:'sync',ms:0,failure:'busy'},
  ]);
  expect(JSON.stringify(metrics.snapshot())).not.toContain('private');
});

it('separates synchronous phase time from elapsed waits and preserves async rejection identity', async () => {
  const {clock,metrics}=fixture();
  let resolve!:(value:string)=>void;
  const pending=metrics.measureAsync('search',()=>{clock.mono+=120;return new Promise<string>(r=>{resolve=r;});});
  expect(metrics.snapshot()).toEqual([{at:clock.wall,phase:'search',kind:'sync',ms:120,failure:'none'}]);
  clock.mono+=600; resolve('private result');
  expect(await pending).toBe('private result');
  expect(metrics.snapshot()[1]).toMatchObject({phase:'search',kind:'elapsed',ms:720,failure:'none'});
  const error=Object.assign(new Error('private request URL'),{name:'TimeoutError'});
  await expect(metrics.measureAsync('notifications',async()=>{clock.mono+=2000;throw error;})).rejects.toBe(error);
  expect(metrics.snapshot().at(-1)).toMatchObject({phase:'notifications',kind:'elapsed',ms:2000,failure:'timeout'});
  expect(JSON.stringify(metrics.snapshot())).not.toContain('private');
});

it('coalesces repeated phase evidence, caps retention, expires old samples and isolates snapshots', () => {
  const {clock,metrics}=fixture();
  for(let i=0;i<1000;i++)metrics.measure('routines',()=>{clock.mono+=150;clock.wall++;});
  expect(metrics.snapshot()).toHaveLength(1);
  for(let wave=0;wave<10;wave++) {
    clock.wall+=30000;
    for(const phase of WEB_OPERATION_PHASES)metrics.measure(phase,()=>{clock.mono+=120;});
  }
  expect(metrics.snapshot()).toHaveLength(32);
  const copy=metrics.snapshot();copy[0].ms=12345;copy.splice(1);
  expect(metrics.snapshot()).toHaveLength(32);expect(metrics.snapshot()[0].ms).toBe(120);
  clock.wall+=300001;expect(metrics.snapshot()).toEqual([]);
});

it('reconstructs only fixed fields and rejects stale, future, malformed and unattributed telemetry', () => {
  const at=1000000;
  const operation={at,phase:'routines',kind:'sync',ms:123.456,failure:'none',private:'secret fixture'};
  const clean={at,phase:'routines',kind:'sync',ms:123.5,failure:'none'};
  expect(sanitizeWebOperations([operation],at)).toEqual([clean]);
  for(const override of [{phase:'private SQL'},{kind:'private URL'},{failure:'private code'},{at:at+1},{at:at-300001},{ms:NaN},{ms:-1}]) {
    expect(sanitizeWebOperations([{...operation,...override}],at)).toEqual([]);
  }
  expect(sanitizeWebOperations(Array.from({length:100},()=>operation),at)).toHaveLength(32);
  expect(sanitizeWebOperations([{...operation,ms:90000}],at)[0].ms).toBe(60000);
  const telemetry={pid:123,at,operations:[operation],private:'secret fixture'};
  expect(readWebOperations(telemetry,123,at)).toEqual([clean]);
  for(const override of [{pid:456},{at:at+1},{at:at-90000},{at:NaN}])expect(readWebOperations({...telemetry,...override},123,at)).toEqual([]);
  expect(readWebOperations(null,123,at)).toEqual([]);
});

it('uses the existing atomic telemetry publication without new timers or per-operation writes', async () => {
  vi.useFakeTimers();
  const mkdir=vi.spyOn(fs,'mkdir').mockResolvedValue(undefined);
  const write=vi.spyOn(fs,'writeFile').mockResolvedValue();
  const rename=vi.spyOn(fs,'rename').mockResolvedValue();
  const {clock,metrics}=fixture();
  const stop=startWebLoopMetrics('/fixture-only',metrics);
  try {
    for(let i=0;i<100;i++)metrics.measure('routines',()=>{clock.mono+=150;});
    expect(write).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(mkdir).toHaveBeenCalledWith('/fixture-only/ops',{recursive:true,mode:0o700});
    expect(write).toHaveBeenCalledTimes(1);expect(rename).toHaveBeenCalledTimes(1);
    const payload=JSON.parse(String(write.mock.calls[0][1]));
    expect(payload.operations).toEqual(metrics.snapshot());
    expect(Object.keys(payload).sort()).toEqual(['at','delayMs','operations','pid']);
    expect(write.mock.calls[0][2]).toEqual({mode:0o600});
    expect(rename.mock.calls[0][1]).toBe('/fixture-only/ops/web-event-loop.json');
  } finally {stop();}
  await vi.advanceTimersByTimeAsync(60000);expect(write).toHaveBeenCalledTimes(1);
});
