export type ToastAction = { label: string; onAction: () => void };

export function Toast({ message, action }: { message: string; action?: ToastAction }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--vp-nav-h)+1rem)] z-40 flex justify-center pr-[calc(env(safe-area-inset-right)+1rem)] pl-[calc(env(safe-area-inset-left)+1rem)]">
      <div className="pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl bg-foreground px-4 py-2.5 text-sm font-medium text-background shadow-lg">
        <span className="line-clamp-2 text-center">{message}</span>
        {action ? (
          <button
            type="button"
            onPointerUp={action.onAction}
            className="-my-1 shrink-0 rounded-full px-2 py-1 font-semibold text-background underline underline-offset-2 active:opacity-70"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
