import type { ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SettingsPageHeader({
  title,
  description,
  action,
}: {
  title: string;
  /** Omitted on pages whose content already says what they are. */
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="max-w-[40ch] text-balance text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-[64ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? (
            <p className="mt-0.5 max-w-[64ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-foreground/10 border-y border-foreground/10', className)}>{children}</div>;
}

export function SettingsRow({
  label,
  description,
  control,
  className,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-16 items-center justify-between gap-4 py-3', className)}>
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {description ? (
          <p className="mt-0.5 text-pretty text-base/7 text-muted-foreground sm:text-sm/6">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function SettingsTabs<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T;
  items: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="-mx-1 overflow-x-auto px-1" role="tablist" aria-label={label}>
      <div className="flex w-max min-w-full gap-1 border-b">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={value === item.value}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative px-3 py-2 text-base text-muted-foreground sm:text-sm',
              value === item.value && 'text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SaveStatus({ children = 'Saved.' }: { children?: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-base/7 text-brand sm:text-sm/6">
      <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}
