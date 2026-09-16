export type ApprovalMode = 'ask' | 'auto';

/** Full Access is the strongest permission setting and always bypasses approvals. */
export function resolveEffectiveApprovalMode(
  fullAccess: boolean,
  conversationMode: ApprovalMode | null | undefined,
  assistantMode: ApprovalMode | null | undefined,
): ApprovalMode {
  if (fullAccess) return 'auto';
  return conversationMode ?? assistantMode ?? 'ask';
}
