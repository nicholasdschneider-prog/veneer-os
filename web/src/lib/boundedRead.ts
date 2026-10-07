/** One in-flight read per component/scope, with no cache of finished results.
 * Explicit refresh after a mutation cancels the old read before starting anew. */
export function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 15000) {
  let current: { controller: AbortController; promise: Promise<T> } | null = null;
  return {
    run(): Promise<T> {
      if (current) return current.promise;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new DOMException('Read timed out', 'TimeoutError')), timeoutMs);
      let remove = () => {};
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        remove = () => controller.signal.removeEventListener('abort', onAbort);
      });
      const entry = { controller, promise: null as unknown as Promise<T> };
      entry.promise = Promise.race([Promise.resolve().then(() => read(controller.signal)), aborted])
        .then(value => { controller.signal.throwIfAborted(); return value; })
        .finally(() => { clearTimeout(timeout); remove(); if (current === entry) current = null; });
      current = entry;
      return entry.promise;
    },
    cancel() { const previous = current; current = null; previous?.controller.abort(); },
  };
}
