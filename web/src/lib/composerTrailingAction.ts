export function composerHasSendableContent(input: {
  draft: string;
  hasReadyAttachment: boolean;
  dictationActive: boolean;
}): boolean {
  return Boolean(input.draft.trim()) || input.hasReadyAttachment || input.dictationActive;
}

export type ComposerTrailingAction = 'hidden' | 'send' | 'stop';

export function composerTrailingAction(input: {
  hasSendableContent: boolean;
  working: boolean;
  canManage: boolean;
  turnInFlight: boolean;
}): ComposerTrailingAction {
  if (input.hasSendableContent) return 'send';
  if (input.working && input.canManage) return 'stop';
  // After send, the draft is empty before `working` flips. Keep the slot so
  // the mic does not bounce out and back in when Stop appears.
  if (input.turnInFlight && input.canManage) return 'send';
  return 'hidden';
}
