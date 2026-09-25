import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Bot, CheckCheck, Clock3, Pencil, Send, Trash2 } from 'lucide-react';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Message, MessageContent, MessageFooter } from '@/components/ui/message';
import { cn } from '@/lib/utils';
import type { MessageOrigin } from '@/lib/types';

export interface QueuedMessageItem {
  id: number;
  text: string;
  /** Set when another agent queued this message rather than the human. */
  origin?: MessageOrigin;
  /** The working bot already holds this text; it reads it at its next step. */
  delivered?: boolean;
}

/** Agent-queued rows keep the right-aligned pending treatment but borrow the
 * delivered agent message's gray tint, bot icon, and source label. */
function agentQueueSource(origin: MessageOrigin | undefined): string | null {
  if (origin?.kind !== 'agent') return null;
  return origin.sourceChat?.title || (origin.from === 'Remote agent' ? 'Remote agent' : origin.from) || 'Agent';
}

const TEXT_TAP_SLOP_PX = 8;

/** Collapsed = 2 lines + ellipsis. Open = capped scroll, never the full screen. */
export function queuedPeekTextClass(open: boolean): string {
  return cn(
    'min-w-0 flex-1 whitespace-pre-wrap break-words text-sm',
    open
      ? 'max-h-[min(40dvh,24rem)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]'
      : 'line-clamp-2',
  );
}

export function QueuedMessageText({
  text,
  className,
  open: openProp,
  subject = 'queued message',
}: {
  text: string;
  className?: string;
  open?: boolean;
  /** Names the thing being expanded in the accessible label. */
  subject?: string;
}) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [seenText, setSeenText] = useState(text);
  const ref = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const controlled = openProp !== undefined;
  if (!controlled && seenText !== text) {
    setSeenText(text);
    setOpen(false);
    setOverflows(false);
  }
  const resolvedOpen = openProp ?? open;
  const expandable = controlled || overflows || resolvedOpen;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || controlled || resolvedOpen) return;

    const measure = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, controlled, resolvedOpen]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (controlled || !expandable || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TEXT_TAP_SLOP_PX) return;
    setOpen((value) => !value);
  };

  const onPointerCancel = () => {
    pointerStart.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (controlled || !expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    setOpen((value) => !value);
  };

  if (!expandable) {
    return (
      <div ref={ref} className={cn(queuedPeekTextClass(false), className)}>
        {text}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-expanded={resolvedOpen}
      aria-label={`${resolvedOpen ? 'Collapse' : 'Expand'} ${subject}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      style={{ touchAction: resolvedOpen ? 'pan-y' : 'manipulation' }}
      className={cn(queuedPeekTextClass(resolvedOpen), 'cursor-pointer text-left', className)}
    >
      {text}
    </div>
  );
}

export function QueuedMessageRow({
  item,
  index,
  count,
  canManage,
  draftBlocked,
  sendingId,
  onSend,
  onEdit,
  onRemove,
  onMove,
}: {
  item: QueuedMessageItem;
  index: number;
  count: number;
  canManage: boolean;
  draftBlocked: boolean;
  sendingId: number | null;
  onSend: (id: number) => void;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
  onMove: (id: number, direction: -1 | 1) => void;
}) {
  const agentSource = agentQueueSource(item.origin);
  const StatusIcon = item.delivered ? CheckCheck : agentSource ? Bot : Clock3;
  return (
    <Message align="end" className="pb-2">
      <MessageContent className="gap-1.5">
        <Bubble
          align="end"
          variant={agentSource ? 'subtle' : 'default'}
          data-origin={agentSource ? 'agent' : undefined}
          className="opacity-60"
        >
          <BubbleContent className="rounded-2xl rounded-br-md border-0 px-4 py-2.5 text-base">
            <QueuedMessageText key={item.id} text={item.text} className="text-base" />
          </BubbleContent>
        </Bubble>
        <MessageFooter className="flex-col items-end gap-1 px-1 sm:px-3">
          <div data-slot="queued-message-status" className="flex min-w-0 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap">
            <StatusIcon className="size-4 shrink-0" aria-hidden="true" />
            {item.delivered ? (
              'Delivered · reading at its next step'
            ) : agentSource ? (
              <>
                <span className="truncate">Queued from {agentSource}</span>
                <span className="shrink-0">· sends after this reply</span>
              </>
            ) : (
              'Queued · sends after this reply'
            )}
          </div>
          {canManage && !item.delivered ? (
            <div
              data-slot="queued-message-actions"
              className="flex max-w-full items-center justify-end gap-2"
              role="group"
              aria-label={`Queued message ${index + 1} actions`}
            >
              <div data-slot="queued-message-icon-actions" className="flex shrink-0 gap-1.5">
                <div className="flex shrink-0 gap-1.5" role="group" aria-label={`Move queued message ${index + 1}`}>
                  <QueueMoveButton
                    direction="up"
                    disabled={index === 0}
                    onMove={() => onMove(item.id, -1)}
                  />
                  <QueueMoveButton
                    direction="down"
                    disabled={index === count - 1}
                    onMove={() => onMove(item.id, 1)}
                  />
                </div>
                <QueueEditButton disabled={draftBlocked} blocked={draftBlocked} onEdit={() => onEdit(item.id)} />
                <QueueTrashButton onRemove={() => onRemove(item.id)} />
              </div>
              <QueueSendNowButton
                sending={sendingId === item.id}
                disabled={sendingId !== null}
                onSend={() => onSend(item.id)}
              />
            </div>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

function QueueSendNowButton({
  sending,
  disabled,
  onSend,
}: {
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
}) {
  return (
    <button
      type="button"
      onPointerUp={onSend}
      disabled={disabled}
      aria-label="Send queued message now"
      title="Send this message into the current reply without stopping it"
      className="relative flex h-7 shrink-0 items-center gap-1 rounded-full bg-foreground/8 py-1 pr-2 pl-1 text-xs font-medium text-muted-foreground hover:bg-foreground/12 hover:text-foreground disabled:opacity-40"
    >
      <Send className="size-4 shrink-0" aria-hidden="true" />
      {sending ? 'Sending…' : 'Send now'}
      <TouchTarget />
    </button>
  );
}

function QueueEditButton({
  disabled,
  blocked,
  onEdit,
}: {
  disabled: boolean;
  blocked: boolean;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      onPointerUp={onEdit}
      disabled={disabled}
      aria-label="Edit queued message"
      title={blocked ? 'Clear the composer to edit a queued message' : 'Edit'}
      className="relative flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground disabled:opacity-30"
    >
      <Pencil className="size-4 shrink-0" aria-hidden="true" />
      <TouchTarget />
    </button>
  );
}

function QueueTrashButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      onPointerUp={onRemove}
      aria-label="Remove queued message"
      title="Delete"
      className="relative flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
    >
      <Trash2 className="size-4 shrink-0" aria-hidden="true" />
      <TouchTarget />
    </button>
  );
}

function QueueMoveButton({
  direction,
  disabled,
  onMove,
}: {
  direction: 'up' | 'down';
  disabled: boolean;
  onMove: () => void;
}) {
  const label = `Move queued message ${direction}`;
  const Icon = direction === 'up' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onPointerUp={onMove}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground disabled:opacity-25"
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <TouchTarget />
    </button>
  );
}

function TouchTarget() {
  return (
    <span
      className="pointer-fine:hidden pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
      aria-hidden="true"
    />
  );
}
