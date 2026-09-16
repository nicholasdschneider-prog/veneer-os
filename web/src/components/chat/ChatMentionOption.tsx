import type { Conversation } from '../../lib/types';
import { ProviderIcon } from '../ProviderIcon';

export function sortChatsByRecentUse(chats: readonly Conversation[]): Conversation[] {
  return chats.toSorted((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

export function ChatMentionOption({
  conversation,
  projectName,
}: {
  conversation: Conversation;
  projectName: string | null;
}) {
  return (
    <>
      <ProviderIcon provider={conversation.provider} className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{conversation.title || 'Untitled chat'}</span>
        {projectName ? (
          <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{projectName}</span>
        ) : null}
      </span>
    </>
  );
}
