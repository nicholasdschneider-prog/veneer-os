import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskPill, DRAG_THRESHOLD, clampPillPosition, isDrag, readPillState, writePillState, type PillState } from './DeskPill';

const noop = () => undefined;
const archer = { id: 'archer-chat', name: 'Archer' };
const pill = (props: Partial<Parameters<typeof DeskPill>[0]> = {}, initialState: PillState = { position: null, minimized: false }) =>
  renderToStaticMarkup(
    <DeskPill front={null} total={0} error={false} chief={archer} onOpenQuestions={noop} onOpenList={noop} onOpenChief={noop} initialState={initialState} {...props} />,
  );
const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), values };
};

describe('desk pill', () => {
  it('keeps the chief of staff reachable with no questions waiting', () => {
    const html = pill();
    expect(html).toContain('aria-label="Chat with Archer"');
    expect(html).toContain('Archer avatar');
    expect(html).toContain('aria-label="Choose from 0 waiting questions"');
    expect(html).toContain('aria-label="Minimize"');
    expect(html).not.toContain('has a question');
  });

  it('shows the chief of staff beside the bot at the front of the line', () => {
    const html = pill({ front: { id: 'henry-chat', name: 'Henry' }, total: 9 });
    expect(html).toContain('aria-label="Chat with Archer"');
    expect(html).toContain('aria-label="Henry has a question"');
    expect(html).toContain('Henry avatar');
    expect(html).toContain('aria-label="Choose from 9 waiting questions"');
    expect(html.indexOf('Chat with Archer')).toBeLessThan(html.indexOf('Henry has a question'));
  });

  it('is unchanged for someone without a chief of staff', () => {
    const html = pill({ chief: null, front: { id: 'henry-chat', name: 'Henry' }, total: 2 });
    expect(html).not.toContain('Chat with');
    expect(html).toContain('aria-label="Henry has a question"');
    expect(pill({ chief: null })).toContain('aria-label="Open question desk"');
  });

  it('minimizes to one labeled avatar button with the waiting count', () => {
    const html = pill({ front: { id: 'henry-chat', name: 'Henry' }, total: 3 }, { position: null, minimized: true });
    expect(html).toContain('data-minimized="true"');
    expect(html).toContain('aria-label="Show Archer and 3 waiting questions"');
    expect(html).toContain('Archer avatar');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('Chat with Archer');
    expect(pill({}, { position: null, minimized: true })).not.toContain('tabular-nums');
  });

  it('renders at its saved spot and in the default corner otherwise', () => {
    expect(pill({}, { position: { x: 40, y: 120 }, minimized: false })).toContain('left:40px;top:120px');
    expect(pill()).not.toContain('left:');
  });
});

describe('desk pill placement', () => {
  const size = { width: 200, height: 56 };
  const viewport = { width: 1000, height: 700 };
  it('clamps a position to the viewport with a margin', () => {
    expect(clampPillPosition({ x: 300, y: 300 }, size, viewport)).toEqual({ x: 300, y: 300 });
    expect(clampPillPosition({ x: -50, y: -9 }, size, viewport)).toEqual({ x: 8, y: 8 });
    expect(clampPillPosition({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 792, y: 636 });
  });
  it('re-clamps a saved spot when the window shrinks, even below the pill size', () => {
    expect(clampPillPosition({ x: 792, y: 636 }, size, { width: 400, height: 300 })).toEqual({ x: 192, y: 236 });
    expect(clampPillPosition({ x: 792, y: 636 }, size, { width: 150, height: 40 })).toEqual({ x: 8, y: 8 });
  });
  it('treats a small wobble as a click and real travel as a drag', () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 12, y: 13 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 10 + DRAG_THRESHOLD, y: 10 })).toBe(true);
  });
  it('persists position and minimized state per device and survives bad data', () => {
    const store = memory();
    expect(readPillState(store)).toEqual({ position: null, minimized: false });
    writePillState(store, { position: { x: 12, y: 34 }, minimized: true });
    expect(readPillState(store)).toEqual({ position: { x: 12, y: 34 }, minimized: true });
    store.values.set('veneer.desk-pill.v1', '{not json');
    expect(readPillState(store)).toEqual({ position: null, minimized: false });
    store.values.set('veneer.desk-pill.v1', JSON.stringify({ position: { x: 'a', y: 2 }, minimized: 'yes' }));
    expect(readPillState(store)).toEqual({ position: null, minimized: false });
    expect(readPillState(null)).toEqual({ position: null, minimized: false });
    expect(() => writePillState({ setItem: () => { throw new Error('full'); } }, { position: null, minimized: false })).not.toThrow();
  });
});
