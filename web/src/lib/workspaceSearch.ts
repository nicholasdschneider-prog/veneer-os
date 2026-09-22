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
    return (
      items.find(
        (item) =>
          item.kind === focus.role &&
          item.turnId === focus.turn &&
          item.at === focus.at,
      )?.key ?? null
    );
  } catch {
    return null;
  }
}
