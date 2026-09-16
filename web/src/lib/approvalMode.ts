import type { ApprovalMode } from './types';

/** Resolve the mode shown in settings and chat controls. Full Access always wins. */
export function resolveEffectiveApprovalMode(
  fullAccess: boolean,
  conversationMode: ApprovalMode | null | undefined,
  assistantMode: ApprovalMode | null | undefined,
): ApprovalMode {
  if (fullAccess) return 'auto';
  return conversationMode ?? assistantMode ?? 'ask';
}
