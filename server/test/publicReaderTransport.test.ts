import {beforeEach,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
const f=vi.hoisted(()=>({lookup:vi.fn(),request:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:f.lookup}));
vi.mock('node:https',()=>({default:{request:f.request}}));
import {requestPublic} from '../src/veneerBrowser/publicReader.js';
beforeEach(()=>{vi.clearAllMocks();});
it('pins a vetted DNS answer, sends no credentials and does not carry a cookie jar',async()=>{
 f.lookup.mockResolvedValue([{address:'1.1.1.1',family:4}]);
 let options:any;
 f.request.mockImplementation((_url,opts,onResponse)=>{
  options=opts;const req=new EventEmitter() as any;req.end=()=>{
   const res=Readable.from([Buffer.from('<p>research</p>')]) as any;res.statusCode=200;res.headers={'content-type':'text/html','set-cookie':'not-carried'};onResponse(res);
  };return req;
 });
 const got=await requestPublic(new URL('https://example.com/'),new AbortController().signal);
 expect(got.body).toBe('<p>research</p>');expect(options.headers).not.toHaveProperty('cookie');expect(options.headers).not.toHaveProperty('authorization');
 // Changing the resolver after validation cannot change the pinned connection.
 f.lookup.mockResolvedValue([{address:'127.0.0.1',family:4}]);
 const callback=vi.fn();options.lookup('example.com',{all:true},callback);expect(callback).toHaveBeenCalledWith(null,[{address:'1.1.1.1',family:4}]);
 expect(f.lookup).toHaveBeenCalledTimes(1);
});
it('rejects mixed public/private DNS answers before opening any socket',async()=>{
 f.lookup.mockResolvedValue([{address:'1.1.1.1',family:4},{address:'127.0.0.1',family:4}]);
 await expect(requestPublic(new URL('https://example.com/'),new AbortController().signal)).rejects.toThrow('blocked_address');expect(f.request).not.toHaveBeenCalled();
});
it('stops oversized responses',async()=>{
 f.lookup.mockResolvedValue([{address:'1.1.1.1',family:4}]);
 f.request.mockImplementation((_url,_opts,onResponse)=>{const req=new EventEmitter() as any;req.end=()=>{const res=Readable.from([Buffer.alloc(2*1024*1024+1)]) as any;res.statusCode=200;res.headers={'content-type':'text/html'};onResponse(res);};return req;});
 await expect(requestPublic(new URL('https://example.com/'),new AbortController().signal)).rejects.toThrow('response_too_large');
});
it('does not open a socket if the deadline expired during DNS lookup',async()=>{
 const controller=new AbortController();f.lookup.mockImplementation(async()=>{controller.abort();return [{address:'1.1.1.1',family:4}];});
 await expect(requestPublic(new URL('https://example.com/'),controller.signal)).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
