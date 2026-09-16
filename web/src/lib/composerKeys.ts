export interface ComposerKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
}

/** Main Enter and keypad Enter submit; Shift keeps the textarea newline. */
export function isComposerSubmitKey(event: ComposerKeyEvent): boolean {
  if (event.shiftKey) return false;
  return event.key === 'Enter' || event.key === 'NumpadEnter' || event.code === 'NumpadEnter';
}
