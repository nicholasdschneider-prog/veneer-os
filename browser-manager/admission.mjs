// FIFO admission only: retries a refused allocation, never a browser command.
// A request which times out is removed and can never start in the background.
export function createAdmissionQueue({ isFull, waitMs = 20_000, retryMs = 250, maxWaiting = 32, fullError }) {
  const waiting = [];
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        const item = waiting[0];
        if (Date.now() >= item.deadline || item.signal?.aborted) {
          waiting.shift(); item.reject(fullError()); continue;
        }
        try {
          const value = await item.attempt(item.deadline);
          waiting.shift(); item.resolve(value);
        } catch (error) {
          if (!isFull(error)) { waiting.shift(); item.reject(error); continue; }
          await new Promise(resolve => setTimeout(resolve, retryMs));
        }
      }
    } finally { pumping = false; }
  };
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
