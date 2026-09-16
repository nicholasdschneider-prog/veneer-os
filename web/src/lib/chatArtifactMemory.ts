const CHAT_ARTIFACT_KEY_PREFIX = 'veneer:chat-artifact:';

function storageKey(conversationId: string): string {
  return `${CHAT_ARTIFACT_KEY_PREFIX}${conversationId}`;
}

export function rememberedChatArtifact(conversationId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(conversationId));
  } catch {
    return null;
  }
}

export function rememberChatArtifact(conversationId: string, artifact: string | null): void {
  try {
    if (artifact) window.sessionStorage.setItem(storageKey(conversationId), artifact);
    else window.sessionStorage.removeItem(storageKey(conversationId));
  } catch {
    // Storage can be unavailable in private browsing; the URL still works.
  }
}

/**
 * Keep storage in step with a chat's artifact route. On first mount, return a
 * remembered artifact for the caller to restore. A later route change from an
 * artifact to the bare chat is Back/close, so it clears the remembered value.
 */
export function syncChatArtifactMemory(
  conversationId: string,
  artifact: string | null,
  previousArtifact: string | null,
  firstCheck: boolean,
): string | null {
  if (artifact) {
    rememberChatArtifact(conversationId, artifact);
    return null;
  }
  if (!firstCheck && previousArtifact) {
    rememberChatArtifact(conversationId, null);
    return null;
  }
  return firstCheck ? rememberedChatArtifact(conversationId) : null;
}
