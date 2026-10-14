import { describe, expect, it, vi } from 'vitest';
import { boundedResolverGet } from '../src/bots/approvedCaseResolver.js';

describe('bounded source transport',()=>{
 it('uses GET without redirects/cache and rejects oversized/error responses',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'fixture'})));vi.stubGlobal('fetch',fetcher);try{expect(await boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).toEqual({id:'fixture'});expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'GET',redirect:'error',cache:'no-store'});fetcher.mockResolvedValue(new Response('x'.repeat(1024*1024+1)));await expect(boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).rejects.toThrow('bound');fetcher.mockResolvedValue(new Response('private error',{status:403}));await expect(boundedResolverGet('https://fixture.invalid','synthetic',AbortSignal.timeout(1000))).rejects.toThrow('unavailable');}finally{vi.unstubAllGlobals();}
 });
});
