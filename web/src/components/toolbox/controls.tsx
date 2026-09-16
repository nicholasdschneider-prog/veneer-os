import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** Segmented single-choice control — mobile-friendly, no native <select>. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-xl border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          onPointerUp={() => !disabled && onChange(o.value)}
          className={`rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
            value === o.value ? 'bg-card text-foreground shadow-sm ring-1 ring-foreground/10' : 'text-muted-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * Editable string→string map (mcp env / headers). Secret values arrive blank
 * from the API (write-only); the placeholder tells the user leaving a value
 * blank keeps the stored secret.
 */
export function KeyValueRows({
  entries,
  onChange,
  keyPlaceholder,
  secret,
  hasStoredSecrets,
}: {
  entries: [string, string][];
  onChange: (next: [string, string][]) => void;
  keyPlaceholder: string;
  secret?: boolean;
  hasStoredSecrets?: boolean;
}) {
  const setKey = (i: number, k: string) => onChange(entries.map((e, j) => (j === i ? [k, e[1]] : e)));
  const setVal = (i: number, v: string) => onChange(entries.map((e, j) => (j === i ? [e[0], v] : e)));
  const remove = (i: number) => onChange(entries.filter((_, j) => j !== i));
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={k}
            onChange={(e) => setKey(i, e.target.value)}
            placeholder={keyPlaceholder}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-10 flex-1 rounded-lg"
          />
          <Input
            value={v}
            onChange={(e) => setVal(i, e.target.value)}
            type={secret ? 'password' : 'text'}
            placeholder={secret && hasStoredSecrets ? '•••• (leave blank to keep)' : 'value'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-10 flex-1 rounded-lg"
          />
          <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onPointerUp={() => remove(i)} aria-label="Remove">
            <X />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="self-start rounded-lg" onPointerUp={() => onChange([...entries, ['', '']])}>
        <Plus />
        Add
      </Button>
    </div>
  );
}
