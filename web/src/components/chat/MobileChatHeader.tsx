import type { ReactNode } from 'react';
import { ChevronDown, ChevronLeft, Monitor } from 'lucide-react';
import { BotAvatar } from '../BotIdentity';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function MobileChatHeader({
  id,
  name,
  status,
  onBack,
  onComputer,
  children,
}: {
  id: string;
  name: string;
  status?: string | null;
  onBack: () => void;
  onComputer?: () => void;
  children: ReactNode;
}) {
  return (
    <header className="grid shrink-0 grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-2 px-3 py-3 md:hidden">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="flex size-12 items-center justify-center rounded-full border bg-background/80 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronLeft className="size-5" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Chat actions for ${name}`}
            className="mx-auto flex min-h-12 max-w-full items-center gap-2 rounded-full border bg-muted/40 px-3 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="shrink-0 [&_svg]:size-7 [&_svg]:rounded-full">
              <BotAvatar id={id} name={name} />
            </span>
            <span className="min-w-0 truncate font-medium">{name}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="max-h-[75dvh] max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <p className="max-w-64 break-words px-2 py-2 text-xs text-muted-foreground">
            {name}
            {status ? ` · ${status}` : ''}
          </p>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {onComputer ? (
        <button
          type="button"
          onClick={onComputer}
          aria-label="Open computer"
          className="flex size-12 items-center justify-center rounded-full border bg-background/80 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Monitor className="size-5" />
        </button>
      ) : (
        <span />
      )}
    </header>
  );
}
