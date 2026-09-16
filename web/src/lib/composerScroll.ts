type ScrollSurface = {
  scrollTop: number;
  readonly scrollHeight: number;
};

/** Keep the mention backdrop aligned, optionally following appended dictation. */
export function syncComposerScroll(
  textarea: ScrollSurface,
  highlight: ScrollSurface | null,
  followEnd: boolean,
): void {
  if (followEnd) textarea.scrollTop = textarea.scrollHeight;
  if (highlight) highlight.scrollTop = textarea.scrollTop;
}
