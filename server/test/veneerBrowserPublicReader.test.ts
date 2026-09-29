import { describe,it,expect,vi } from 'vitest';
import { publicAddress,publicUrl,extractPublicHtml,readPublicUrl,requestPublic } from '../src/veneerBrowser/publicReader.js';

describe('credential-free public research',()=>{
  it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','224.0.0.1'])('refuses nonpublic address %s',ip=>expect(publicAddress(ip)).toBe(false));
  it.each(['http://localhost/','http://2130706433/','http://[::ffff:127.0.0.1]/','file:///tmp/x','https://user:password@example.com/','http://example.com:3100/','http://metadata.google.internal/'])('refuses URL %s',url=>expect(()=>publicUrl(url)).toThrow());
  it('supports globally routable addresses',()=>{expect(publicAddress('1.1.1.1')).toBe(true);expect(publicAddress('2606:4700:4700::1111')).toBe(true);});
  it('extracts research without scripts or form values and bounds output',()=>{
    const out=extractPublicHtml('<title>Research</title><script>secret()</script><input value="secret"><textarea>draft</textarea><div hidden>hidden</div><p>Visible &amp; useful</p>',1000);
    expect(out).toEqual({title:'Research',text:'Visible & useful',truncated:false});
    expect(extractPublicHtml('<p>'+'x'.repeat(1000)+'</p>',100).text.length).toBeLessThanOrEqual(100);
  });
  it('serves more than five sequential projects without any browser session',async()=>{
    const transport=vi.fn(async()=>({status:200,contentType:'text/html',body:'<p>Public facts</p>'}));
    for(let i=0;i<12;i++)expect((await readPublicUrl({url:`https://example.com/${i}`,max_chars:1000,timeout_ms:1000},transport)).text).toBe('Public facts');
    expect(transport).toHaveBeenCalledTimes(12);
  });
  it('refuses private redirect without a second connection and does not retry authentication',async()=>{
    const transport=vi.fn(async()=>({status:302,location:'http://169.254.169.254/',contentType:'',body:''}));
    expect((await readPublicUrl({url:'https://example.com/',max_chars:1000,timeout_ms:1000},transport)).ok).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    const denied=await readPublicUrl({url:'https://example.com/',max_chars:1000,timeout_ms:1000},async()=>({status:401,body:'',contentType:'text/html'}));
    expect(denied.error?.code).toBe('http_error');
  });
  it('actual transport rejects private literals before a socket is created',async()=>{
    await expect(requestPublic(new URL('http://127.0.0.1/'),new AbortController().signal)).rejects.toThrow('blocked_address');
  });
  it('bounds concurrent work and timeout, with no background fetch after expiry',async()=>{
    vi.useFakeTimers();
    try {
      const transport=vi.fn(async(_url,signal)=>new Promise<any>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))));
      const input={url:'https://example.com/',max_chars:1000,timeout_ms:1000};
      const jobs=Array.from({length:4},()=>readPublicUrl(input,transport));
      expect((await readPublicUrl(input,transport)).error?.code).toBe('reader_busy');
      await vi.advanceTimersByTimeAsync(1000);
      expect((await Promise.all(jobs)).every(x=>!x.ok)).toBe(true);
      expect(transport).toHaveBeenCalledTimes(4);
    } finally {vi.useRealTimers();}
  });
});
