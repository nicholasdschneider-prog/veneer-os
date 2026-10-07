// Node 24: node --import tsx scripts/decision-polling-benchmark.mjs
// Synthetic history and viewers; never opens or writes the live database.
import { decisionLoad } from '../server/test/fixtures/decisionLoad.ts';
import { questionLine } from '../server/src/bots/questionLine.ts';
import { createBotService } from '../server/src/bots/service.ts';
const { db, users } = decisionLoad();
const start = performance.now(), cpu = process.cpuUsage(); const times=[];
try {
  for(let round=0;round<10;round++) for(const user of users) {
    const at=performance.now(); questionLine({db},user).snapshot(); times.push(performance.now()-at);
  }
  const full=performance.now(); createBotService(db).list({user:users[0]}); const fullMs=performance.now()-full;
  const usage=process.cpuUsage(cpu);times.sort((a,b)=>a-b);
  console.log(JSON.stringify({syntheticDecisions:558,viewers:3,snapshots:times.length,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.floor(times.length*.95)],fullListMs:fullMs,totalWallMs:performance.now()-start,totalCpuMs:(usage.user+usage.system)/1000}));
} finally {db.close();}
