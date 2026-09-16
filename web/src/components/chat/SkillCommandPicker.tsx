import type { SkillCommand } from '../../lib/skillCommands';

export function SkillCommandPicker({
  items,
  activeIndex,
  onSelect,
}: {
  items: SkillCommand[];
  activeIndex: number;
  onSelect: (item: SkillCommand) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Skills"
      className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-48 overflow-y-auto rounded-xl border bg-popover p-1 shadow-md"
    >
      {items.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">No matching skills</p>
      ) : (
        items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            disabled={item.conflict}
            onPointerUp={() => onSelect(item)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${index === activeIndex ? 'bg-accent' : ''}`}
          >
            <span className="shrink-0 font-medium">/{item.name}</span>
            {item.description ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.description}</span> : <span className="flex-1" />}
            <span className="shrink-0 text-xs text-muted-foreground">{item.scopeLabel}</span>
          </button>
        ))
      )}
    </div>
  );
}
