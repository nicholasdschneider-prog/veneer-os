import { createContext, type CSSProperties } from 'react';

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

/** True inside the question desk while it is a full-screen sheet (below the
 * `lg` breakpoint). The sheet sizes itself to the visual viewport, so a chat
 * rendered inside it must not apply its own keyboard offset or top inset. */
export const DeskSheetContext = createContext(false);
export const DESK_DOCKED_QUERY = '(min-width: 1024px)';

/** Bounds for the open desk sheet while its keyboard is up. Without a focused
 * field the sheet falls back to its full-screen CSS, because iOS can leave
 * visualViewport at a stale keyboard-sized height after the keyboard closes. */
export function deskSheetStyle(
  sheet: boolean,
  typing: boolean,
  viewport: Pick<VisualViewport, 'height' | 'width' | 'offsetTop' | 'offsetLeft'> | null,
): CSSProperties | undefined {
  if (!sheet || !typing || !viewport) return undefined;
  return {
    inset: 'auto',
    top: `${viewport.offsetTop}px`,
    left: `${viewport.offsetLeft}px`,
    width: `${viewport.width}px`,
    height: `${viewport.height}px`,
  };
}
