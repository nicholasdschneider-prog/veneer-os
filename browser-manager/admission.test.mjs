import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionQueue } from './admission.mjs';
const full = () => Object.assign(new Error('full'), { status: 429 });
const queue = (options = {}) => createAdmissionQueue({ isFull: e => e.status === 429, retryMs: 5, waitMs: 50, fullError: full, ...options });

test('waits fairly and admits queued projects in arrival order when capacity frees', async () => {
  const q = queue({ waitMs: 500 }); const order = []; let occupied = true;
  const first = q.run(async () => { if (occupied) throw full(); order.push('first'); return 1; });
  const second = q.run(async () => { order.push('second'); return 2; });
  setTimeout(() => { occupied = false; }, 15);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first', 'second']); assert.equal(q.depth, 0);
});
test('timed-out allocations are removed and never run later', async () => {
  const q = queue(); let attempts = 0;
  await assert.rejects(q.run(async () => { attempts++; throw full(); }), /full/);
  const ended = attempts;
  await new Promise(r => setTimeout(r, 20)); assert.equal(attempts, ended); assert.equal(q.depth, 0);
});
test('non-capacity errors are never retried, including uncertain starts', async () => {
  const q = queue(); let count = 0;
  await assert.rejects(q.run(async () => { count++; throw new Error('lost response'); }), /lost response/);
  assert.equal(count, 1);
});
test('cancels queued requests and bounds queue size', async () => {
  const q = queue({ maxWaiting: 1 }); const controller = new AbortController();
  const first = q.run(async () => { throw full(); }, controller.signal);
  await assert.rejects(q.run(async () => 2), /full/);
  controller.abort(); await assert.rejects(first, /full/); assert.equal(q.depth, 0);
});
