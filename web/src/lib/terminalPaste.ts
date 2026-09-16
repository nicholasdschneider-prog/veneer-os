const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** Match wterm's native paste handling, including its escape-byte safeguard. */
export function prepareTerminalPaste(text: string, bracketedPaste: boolean): string {
  if (!bracketedPaste) return text;
  return `${BRACKETED_PASTE_START}${text.replace(/\x1b/g, '')}${BRACKETED_PASTE_END}`;
}
