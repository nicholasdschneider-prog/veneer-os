import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { BotError } from '../bots/service.js';
import { helperDescriptorSchema, type HelperDescriptor } from './phaseContract.js';
import type { HelperTransport } from './phaseBoundary.js';
const fail=()=>new BotError(503,'QBO_HELPER_PROCESS_UNAVAILABLE');
// Same local spawn/private-pipe facility as native providers. No shell, token,
// inherited application environment, stderr logging or caller-selected executable.
export function ownedHelperTransport(timeoutMs=30000):HelperTransport {
  return {async prepare(raw:HelperDescriptor){
    const descriptor=helperDescriptorSchema.parse(raw);
    async function freeze(){
      const entries=[descriptor.executable,descriptor.script,...descriptor.dependencies];
      const data:Buffer[]=[];
      for(const entry of entries){
        if(await fs.realpath(entry.path)!==entry.path)throw fail();
        const handle=await fs.open(entry.path,'r');
        try{const stat=await handle.stat();if(!stat.isFile()||stat.uid!==descriptor.uid||(stat.mode&0o022)!==0||stat.size>150*1024*1024)throw fail();
          const bytes=await handle.readFile();if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw fail();data.push(bytes);
        }finally{await handle.close();}
      }
      return data;
    }
    await freeze(); // Pre-admission check; actual executed bytes are re-read and frozen below.
    return async(input,onEvent)=>{
      const bytes=await freeze(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'veneer-qbo-helper-'));
      try{
        await fs.chmod(dir,0o700);
        const names=descriptor.dependencies.map(v=>path.basename(v.path));
        const scriptName=path.basename(descriptor.script.path);
        if(new Set(['runtime',scriptName,...names]).size!==names.length+2)throw fail();
        await fs.writeFile(path.join(dir,'runtime'),bytes[0]!,{mode:0o500});
        await fs.writeFile(path.join(dir,scriptName),bytes[1]!,{mode:0o400});
        for(let i=0;i<names.length;i++)await fs.writeFile(path.join(dir,names[i]!),bytes[i+2]!,{mode:0o400});
        // Runtime options are chosen by accepted runtime kind, never by a bot.
        const args=descriptor.runtime==='python'?['-I','-S','-B',path.join(dir,scriptName)]:['--no-addons',path.join(dir,scriptName)];
        await new Promise<void>((resolve,reject)=>{
          const child=spawn(path.join(dir,'runtime'),args,{cwd:dir,env:{LANG:'C.UTF-8',TZ:'UTC'},stdio:['pipe','pipe','ignore'],shell:false});
          let pending='',count=0,failed=false;
          const abort=()=>{if(!failed){failed=true;child.kill('SIGKILL');}};
          const timer=setTimeout(abort,timeoutMs);timer.unref();
          child.on('error',()=>{failed=true;});
          child.stdin.on('error',abort);
          child.stdout.on('data',(b:Buffer)=>{
            if(failed)return;
            pending+=b.toString('utf8');if(Buffer.byteLength(pending)>32768){abort();return;}
            let end:number;
            while((end=pending.indexOf('\n'))>=0){
              const line=pending.slice(0,end);pending=pending.slice(end+1);
              try{if(++count>100)throw fail();const result=onEvent(JSON.parse(line));child.stdin.write(JSON.stringify(result)+'\n');}
              catch{abort();return;}
            }
          });
          child.on('close',code=>{clearTimeout(timer);if(failed||code!==0||pending.length)reject(fail());else resolve();});
          child.stdin.write(JSON.stringify(input)+'\n');
        });
      }finally{await fs.rm(dir,{recursive:true,force:true});}
    };
  }};
}
