import type { ReactNode } from 'react';
import { Bot, ChevronDown, ExternalLink } from 'lucide-react';
import { CollapsedMessageDisclosure } from '@/components/chat/CollapsedMessageDisclosure';
import type { MessageOrigin } from '@/lib/types';

type LocalAgentOrigin = MessageOrigin & { kind: 'agent'; local: true };

export function isLocalAgentOrigin(origin: MessageOrigin): origin is LocalAgentOrigin {
  return origin.kind === 'agent' && origin.local === true;
}

export function AgentMessagePromptDisclosure({
  origin,
  children,
}: {
  origin: LocalAgentOrigin;
  children: ReactNode;
}) {
  const source = origin.sourceChat;
  const sender = source?.title || origin.from.trim() || 'Agent';

  return (
    <CollapsedMessageDisclosure
      aria-label={`Message from ${sender}`}
      summaryClassName="min-h-12 gap-2 px-3 py-2 text-sm font-medium text-foreground/70"
      summary={(
        <>
          <Bot className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Message from {sender}</span>
          <ChevronDown
            className="size-4 shrink-0 stroke-muted-foreground group-open/message-disclosure:rotate-180"
            aria-hidden="true"
          />
        </>
      )}
    >
      <div
        data-agent-message-body
        className="max-h-[min(60dvh,36rem)] overflow-y-auto overscroll-contain border-t border-border/60 px-3 py-2.5 text-base/7 text-foreground/85 sm:text-sm/6"
      >
        <div className="whitespace-pre-wrap break-words">{children}</div>
        {source ? (
          <div className="pt-2 text-sm sm:text-xs">
            <a
              href={`#/chat/${source.id}`}
              data-app-route={`#/chat/${source.id}`}
              aria-label={`Open source chat ${source.title}`}
              className="relative inline-flex items-center gap-1 rounded-sm py-1.5 pr-1.5 pl-2.5 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span>Open source chat</span>
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              <span
                className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                aria-hidden="true"
              />
            </a>
          </div>
        ) : null}
      </div>
    </CollapsedMessageDisclosure>
  );
}
