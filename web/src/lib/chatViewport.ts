export interface ChatViewportStyle {
  height: string;
  transform: string;
}

export function chatViewportStyle(
  composerFocused: boolean,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop'> | null,
): ChatViewportStyle {
  if (!composerFocused || !viewport) return { height: '100%', transform: '' };
  return {
    height: `min(${viewport.height}px, 100%)`,
    transform: viewport.offsetTop ? `translateY(${viewport.offsetTop}px)` : '',
  };
}

export function shouldDismissChatKeyboard(pointerType: string, coarsePointer: boolean): boolean {
  return pointerType === 'touch' || coarsePointer;
}

export function isChatKeyboardActive(
  composerFocused: boolean,
  composerElement: object | null,
  activeElement: object | null,
): boolean {
  return composerFocused && composerElement !== null && activeElement === composerElement;
}
