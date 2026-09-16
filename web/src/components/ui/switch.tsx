/**
 * A small on/off toggle. The thumb is anchored with an explicit `left-0.5`
 * rather than relying on its absolute static position — a bare `<button>` has a
 * UA-default `text-align: center`, which WebKit uses to center an unanchored
 * absolute child's static position, so a translate on top of that shoved the
 * thumb half off the right edge. `left-0.5` + a spacing-scale `translate-x-5`
 * keeps the geometry self-consistent regardless of the browser.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: () => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange()}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-brand' : 'bg-input'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
