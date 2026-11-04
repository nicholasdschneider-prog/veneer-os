/** A polling callback that skips ticks while its tab is hidden. A person with many
 * tabs open otherwise has each one asking the server the same lists all day. */
export function whenVisible(poll: () => unknown): () => void {
  return () => {
    if (document.visibilityState !== 'hidden') void poll();
  };
}
