import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CLOUDFLARE_LOGOUT_PATH } from '@/lib/cloudflareAccess';
import { VeneerMark } from './VeneerMark';

/**
 * Account menu mounted in the app's brand slot: the signed-in identity and the
 * logout action.
 *
 * There is no dropdown-menu primitive in this codebase, so this follows the
 * hand-rolled popover pattern used elsewhere (rounded-xl border bg-popover
 * shadow) with its own click-outside / Escape dismissal.
 */
export function AccountMenu({
  email,
  placement = 'desktop',
  brand,
}: {
  email: string;
  placement?: 'desktop' | 'mobile';
  brand?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointerdown or Escape. Only wired while open so the
  // listeners aren't live for the (common) closed case.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-placement={placement}
      className={cn('relative flex items-center justify-center', open && 'z-40')}
    >
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerUp={() => setOpen((v) => !v)}
        className={cn(
          'flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted',
          open && 'bg-muted',
        )}
      >
        {brand ?? <VeneerMark className="size-6" />}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute z-30 max-h-[70vh] w-60 overflow-y-auto rounded-xl border bg-popover p-1 shadow-md',
            placement === 'mobile'
              ? 'bottom-full left-0 mb-2'
              : 'left-full top-0 ml-2',
          )}
        >
          <AccountMenuItems email={email} />
        </div>
      ) : null}
    </div>
  );
}

const ROW_BASE = 'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm';

export function AccountMenuItems({ email }: { email: string }) {
  return (
    <>
      <div className="min-w-0 px-2.5 pb-2 pt-1.5">
        <p className="text-xs font-medium text-muted-foreground">Signed in as</p>
        <p className="truncate text-sm font-medium" title={email}>
          {email}
        </p>
      </div>
      <div className="my-1 border-t" role="separator" />
      <a
        href={CLOUDFLARE_LOGOUT_PATH}
        role="menuitem"
        className={cn(ROW_BASE, 'items-center text-destructive hover:bg-accent')}
      >
        <LogOut className="size-4 shrink-0" />
        <span className="font-medium">Log out</span>
      </a>
    </>
  );
}
