/** Set or clear the `side` query param on a chat hash, e.g. `#/chat/<id>?side=open`. */
export function withSideParam(hash: string, value: string | null): string {
  const [path, query = ''] = (hash || '#/').split('?');
  const params = new URLSearchParams(query);
  if (value) params.set('side', value);
  else params.delete('side');
  const next = params.toString();
  return `${path}${next ? `?${next}` : ''}`;
}

export const sideChatHash = (conversationId: string, from?: string | null) =>
  withSideParam(`#/chat/${encodeURIComponent(conversationId)}${from ? `?from=${from}` : ''}`, 'open');
