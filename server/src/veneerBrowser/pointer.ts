/**
 * Coordinate pointer tools.
 *
 * agent-browser's `mouse` verb sends compositor-level events, so it reaches the
 * places an accessibility ref cannot: cross-origin iframes, canvas, and closed
 * shadow roots. One logical click is three separate CLI commands, so the plan
 * built here is handed to the manager as a sequence and run inside a single
 * conversation queue slot — a `mouse down` must never be separated from its
 * `mouse up` by another chat command.
 *
 * Everything in this file is pure: it validates agent-supplied numbers and
 * turns them into argv. No coordinate ever reaches a shell.
 */

const BUTTONS = new Set(['left', 'right', 'middle']);
/** Far past any real viewport or scroll delta, and small enough to stay sane. */
const MAX_COORDINATE = 20_000;

function pointerNumber(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number of viewport pixels, taken from a recent screenshot.`);
  }
  const whole = Math.trunc(value);
  if (whole < min || whole > max) throw new Error(`${field} must be between ${min} and ${max}.`);
  // Math.trunc(-0) is -0, and String(-0) is "0", so no sign leaks into argv.
  return String(whole);
}

function pointerButton(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'left';
  const name = String(value).toLowerCase();
  if (!BUTTONS.has(name)) throw new Error('button must be left, right, or middle.');
  return name;
}

/**
 * The argv sequence for a coordinate pointer tool, or null when the tool name
 * is not one of them. Throws a descriptive error for a bad coordinate so the
 * agent is told what to fix rather than being handed a CLI parse failure.
 */
export function pointerCommands(name: string, args: Record<string, unknown>): string[][] | null {
  if (name === 'click_at') {
    const x = pointerNumber(args.x, 'x', 0, MAX_COORDINATE);
    const y = pointerNumber(args.y, 'y', 0, MAX_COORDINATE);
    const button = pointerButton(args.button);
    return [['mouse', 'move', x, y], ['mouse', 'down', button], ['mouse', 'up', button]];
  }
  if (name === 'hover_at') {
    const x = pointerNumber(args.x, 'x', 0, MAX_COORDINATE);
    const y = pointerNumber(args.y, 'y', 0, MAX_COORDINATE);
    return [['mouse', 'move', x, y]];
  }
  if (name === 'scroll_at') {
    const x = pointerNumber(args.x, 'x', 0, MAX_COORDINATE);
    const y = pointerNumber(args.y, 'y', 0, MAX_COORDINATE);
    const dy = pointerNumber(args.dy, 'dy', -MAX_COORDINATE, MAX_COORDINATE);
    const dx = args.dx === undefined || args.dx === null
      ? []
      : [pointerNumber(args.dx, 'dx', -MAX_COORDINATE, MAX_COORDINATE)];
    return [['mouse', 'move', x, y], ['mouse', 'wheel', dy, ...dx]];
  }
  return null;
}

/** Human summary of a completed plan, read back off the argv that actually ran. */
export function pointerSummary(name: string, commands: string[][]): string {
  const move = commands[0] ?? [];
  const at = `(${move[2] ?? '?'}, ${move[3] ?? '?'})`;
  if (name === 'click_at') {
    const button = commands[1]?.[2] ?? 'left';
    return button === 'left' ? `Clicked at ${at}.` : `Clicked at ${at} with the ${button} button.`;
  }
  if (name === 'hover_at') return `Moved the pointer to ${at}.`;
  if (name === 'scroll_at') {
    const wheel = commands[1] ?? [];
    const horizontal = wheel[3] ? ` and ${wheel[3]} horizontally` : '';
    return `Scrolled at ${at} by ${wheel[2] ?? '0'} vertically${horizontal}.`;
  }
  return 'Pointer command finished.';
}
