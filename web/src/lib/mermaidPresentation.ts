export const MERMAID_CHART_SELECTOR =
  "[data-streamdown='mermaid'] [role='img'][aria-label='Mermaid chart']";

const MERMAID_BLOCK_SELECTOR = "[data-streamdown='mermaid-block']";
const MERMAID_FULLSCREEN_BUTTON_SELECTOR = "button[aria-label='View fullscreen']";
const TAP_SLOP_PX = 6;

type ClosestElement = {
  closest(selector: string): ClosestElement | null;
  querySelector(selector: string): ClickableElement | null;
};

type ClickableElement = {
  click(): void;
};

export type MermaidPointerStart = {
  pointerId: number;
  clientX: number;
  clientY: number;
  target: EventTarget;
};

function closestElement(target: EventTarget | null, selector: string): ClosestElement | null {
  if (!target || typeof (target as Partial<ClosestElement>).closest !== 'function') return null;
  return (target as unknown as ClosestElement).closest(selector);
}

export function isMermaidChartTarget(target: EventTarget | null): boolean {
  return closestElement(target, MERMAID_CHART_SELECTOR) !== null;
}

export function isMermaidTap(
  start: MermaidPointerStart,
  end: { pointerId: number; clientX: number; clientY: number },
): boolean {
  return start.pointerId === end.pointerId
    && Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) <= TAP_SLOP_PX;
}

/** Open Streamdown's viewer through its own accessible fullscreen control. */
export function openMermaidFullscreen(target: EventTarget | null): boolean {
  const chart = closestElement(target, MERMAID_CHART_SELECTOR);
  const block = chart?.closest(MERMAID_BLOCK_SELECTOR);
  const button = block?.querySelector(MERMAID_FULLSCREEN_BUTTON_SELECTOR);
  if (!button) return false;
  button.click();
  return true;
}
