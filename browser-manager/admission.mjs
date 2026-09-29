// FIFO admission only: retries a refused allocation, never a browser command.
// A request which times out is removed and can never start in the background.
// Arrival order is kept while the whole machine is full. A waiter refused only
// by its own project's cap steps aside for later waiters from other projects,
// so one busy project never stalls every other project's queue.
export function createAdmissionQueue({ isFull, isProjectFull = () => false, waitMs = 20_000, retryMs = 250, maxWaiting = 32, fullError }) {
  const waiting = [];
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        let admitted = false;
        for (const item of [...waiting]) {
          if (!waiting.includes(item)) continue;
          if (Date.now() >= item.deadline || item.signal?.aborted) {
            remove(item); item.reject(fullError()); continue;
          }
          try {
            const value = await item.attempt(item.deadline);
            remove(item); item.resolve(value); admitted = true;
          } catch (error) {
            if (!isFull(error)) { remove(item); item.reject(error); continue; }
            if (!isProjectFull(error)) break;
          }
        }
        if (!admitted && waiting.length) await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    } finally { pumping = false; }
  };
  const remove = (item) => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); };
  return {
    get depth() { return waiting.length; },
    run(attempt, signal) {
      if (waiting.length >= maxWaiting) return Promise.reject(fullError());
      return new Promise((resolve, reject) => {
        waiting.push({ attempt, signal, resolve, reject, deadline: Date.now() + waitMs });
        void pump();
      });
    },
  };
}
