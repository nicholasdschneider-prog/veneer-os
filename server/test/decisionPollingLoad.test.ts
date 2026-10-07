import { expect, it } from 'vitest';
import { decisionLoad, countReads } from './fixtures/decisionLoad.js';
import { questionLine } from '../src/bots/questionLine.js';
import { createBotService } from '../src/bots/service.js';

it('bounds work with 540 historical cases, discussion history and concurrent viewers', async () => {
  const {db,users}=decisionLoad(); const measured=countReads(db);
  try {
    const snapshots=await Promise.all(users.map(async user=>{
      measured.reset(); const result=questionLine({db:measured.db},user).snapshot();
      expect(measured.counts.prepare).toBeLessThan(45);
      expect(measured.counts.reads).toBeLessThan(350);
      return result;
    }));
    expect(snapshots.map(s=>s.decisions.length)).toEqual([18,18,3]);
    expect(new Set(snapshots[0]!.decisions.slice(0,6).map(d=>d.conversation_id)).size).toBe(6);
    measured.reset(); const all=createBotService(measured.db).list({user:users[0]!});
    expect(all).toHaveLength(558);
    expect(measured.counts.prepare).toBeLessThan(40);
    expect(measured.counts.reads).toBeLessThan(4500);
    // Same running component/service must observe permission and case changes.
    const line=questionLine({db:measured.db},users[1]!);
    db.prepare("DELETE FROM employee_bot_access WHERE user_id=2 AND conversation_id='load-0'").run();
    expect(line.snapshot().decisions.some(d=>d.conversation_id==='load-0')).toBe(false);
    const first=snapshots[0]!.decisions[0]!;
    db.prepare("UPDATE bot_decisions SET stale_json=? WHERE id=?").run(JSON.stringify({reason:'new_evidence',resolved:true,detail:'Synthetic new evidence'}),first.id);
    expect(questionLine({db},users[0]!).snapshot().decisions.some(d=>d.id===first.id)).toBe(false);
    const second=snapshots[0]!.decisions[1]!;
    const service=createBotService(db);
    service.handle({user:users[0]!},second.id,1,'load-claim','claim',0);
    service.choose({user:users[0]!},second.id,1,'load-answer','use','','this_case',1);
    expect(questionLine({db},users[0]!).snapshot().decisions.some(d=>d.id===second.id)).toBe(false);
  } finally {db.close();}
});

it('does not hydrate completed history as history doubles', () => {
  const readCounts:number[]=[];
  for(const history of [270,540]) {
    const {db,users}=decisionLoad(history);const measured=countReads(db);
    try {questionLine({db:measured.db},users[0]!).snapshot();readCounts.push(measured.counts.reads);} finally {db.close();}
  }
  expect(readCounts[1]).toBe(readCounts[0]);
});
