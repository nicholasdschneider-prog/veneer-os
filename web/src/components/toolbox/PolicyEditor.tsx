import { Plus, X } from 'lucide-react';
import type { Policy, PolicyAction } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from './controls';

/** Plain-language hints so a non-technical owner understands each action. */
const ACTION_OPTIONS: { value: PolicyAction; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'approve', label: 'Ask first' },
  { value: 'deny', label: 'Block' },
];

const ACTION_HINT: Record<PolicyAction, string> = {
  allow: 'Runs without asking.',
  approve: 'Asks you before doing it.',
  deny: 'Never runs.',
};

export function PolicyEditor({ policy, onChange }: { policy: Policy; onChange: (p: Policy) => void }) {
  const setRule = (i: number, patch: Partial<{ match: string; action: PolicyAction }>) =>
    onChange({ ...policy, rules: policy.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const removeRule = (i: number) => onChange({ ...policy, rules: policy.rules.filter((_, j) => j !== i) });
  const addRule = () => onChange({ ...policy, rules: [...policy.rules, { match: '', action: 'approve' }] });

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">By default, tools from this connection…</span>
        <Segmented value={policy.default} options={ACTION_OPTIONS} onChange={(v) => onChange({ ...policy, default: v })} />
        <span className="text-xs text-muted-foreground">{ACTION_HINT[policy.default]}</span>
      </div>

      {policy.rules.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Exceptions</span>
          {policy.rules.map((r, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg border bg-card p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  value={r.match}
                  onChange={(e) => setRule(i, { match: e.target.value })}
                  placeholder="e.g. mcp__shopify__get_*"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-10 flex-1 rounded-lg font-mono text-sm"
                />
                <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onPointerUp={() => removeRule(i)} aria-label="Remove rule">
                  <X />
                </Button>
              </div>
              <Segmented value={r.action} options={ACTION_OPTIONS} onChange={(v) => setRule(i, { action: v })} />
            </div>
          ))}
        </div>
      ) : null}

      <Button variant="outline" size="sm" className="self-start rounded-lg" onPointerUp={addRule}>
        <Plus />
        Add an exception
      </Button>
      <p className="text-xs text-muted-foreground">
        Exceptions are checked top to bottom; the first match wins. Use <span className="font-mono">*</span> to match any
        tool name.
      </p>
    </div>
  );
}
