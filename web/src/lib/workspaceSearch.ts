/** Resolve a search permalink without changing transcript keys or message ordering. */
export function workspaceSearchFocusKey(
  value: string | null | undefined,
  items: readonly { kind: string; key: string; turnId?: string; at?: string }[],
): string | null {
  if (!value?.startsWith('search:') || value.length > 2000) return null;
  try {
    const focus = JSON.parse(value.slice(7));
    if (
      !focus ||
      !['user', 'assistant'].includes(focus.role) ||
      typeof focus.turn !== 'string' ||
      typeof focus.at !== 'string'
    )
      return null;
    const sameMessage = items.filter((item) => item.kind === focus.role && item.at === focus.at);
    // A session change renames frozen turn ids, so a link made earlier can only
    // fall back to its role and time, and only when that is unambiguous.
    return (
      sameMessage.find((item) => item.turnId === focus.turn)?.key ??
      (sameMessage.length === 1 ? sameMessage[0]!.key : null)
    );
  } catch {
    return null;
  }
}
