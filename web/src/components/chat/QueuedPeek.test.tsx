import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QueuedMessageRow, QueuedMessageText, SteeredMessageRow, queuedPeekTextClass } from './QueuedPeek';

const item = { id: 1, text: 'Fix and then roll out new version to clients' };
const noop = () => undefined;

function render(props: Partial<Parameters<typeof QueuedMessageRow>[0]> = {}) {
  return renderToStaticMarkup(
    <QueuedMessageRow
      item={item}
      index={0}
      count={1}
      canManage
      draftBlocked={false}
      sendingId={null}
      onSend={noop}
      onEdit={noop}
      onRemove={noop}
      onMove={noop}
      {...props}
    />,
  );
}

function openingButton(html: string, label: string): string {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
}

function openingSlot(html: string, slot: string): string {
  return html.match(new RegExp(`<div[^>]*data-slot="${slot}"[^>]*>`))?.[0] ?? '';
}

describe('QueuedMessageRow', () => {
  it('renders a dimmed user bubble with explicit queue status and actions', () => {
    const html = render();
    expect(html).toContain('data-align="end"');
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('opacity-60');
    expect(html).toContain('Fix and then roll out new version to clients');
    expect(html).toContain('Queued · sends after this reply');
    expect(html).toContain('Send now');
    expect(html).toContain('data-slot="queued-message-status"');
    expect(html).toContain('data-slot="queued-message-actions"');
    expect(openingButton(html, 'Edit queued message')).toContain('title="Edit"');
    expect(openingButton(html, 'Remove queued message')).toContain('title="Delete"');
    expect(html).not.toContain('>Edit<');
    expect(html).not.toContain('>Delete<');
    expect(html).not.toContain('waiting');
    expect(html).not.toContain('Drag to reorder');
  });

  it('shows a steered message as delivered without queue actions', () => {
    const html = render({ item: { ...item, delivered: true } });
    expect(html).toContain('Delivered · reading at its next step');
    expect(html).not.toContain('data-slot="queued-message-actions"');
    expect(html).not.toContain('Send now');
  });

  it('explains that Send now joins the current reply instead of stopping it', () => {
    expect(openingButton(render(), 'Send queued message now')).toContain('without stopping it');
  });

  it('marks an agent-queued message with the gray agent tint, bot icon, and source', () => {
    const html = render({
      item: {
        ...item,
        origin: { kind: 'agent', from: 'Assistant', to: 'Assistant', sourceChat: { id: 'src', title: 'Choppy Market' } },
      },
    });
    expect(html).toContain('data-align="end"');
    expect(html).toContain('data-variant="subtle"');
    expect(html).toContain('opacity-60');
    expect(html).toContain('Queued from Choppy Market');
    expect(html).toContain('sends after this reply');
    expect(html).toContain('lucide-bot');
    expect(html).not.toContain('lucide-clock');
  });

  it('falls back to the sender name when the source chat is not viewable', () => {
    const html = render({ item: { ...item, origin: { kind: 'agent', from: 'Remote agent', to: 'Assistant' } } });
    expect(html).toContain('Queued from Remote agent');
    expect(html).toContain('data-variant="subtle"');
  });

  it('leaves scheduler wake-ups on the ordinary user treatment', () => {
    const html = render({ item: { ...item, origin: { kind: 'wakeup', from: 'Assistant', to: 'Assistant' } } });
    expect(html).toContain('data-variant="default"');
    expect(html).toContain('Queued · sends after this reply');
  });

  it('groups controls below the status with send now last and larger move buttons', () => {
    const html = render({ index: 1, count: 3 });

    expect(html.indexOf('queued-message-status')).toBeLessThan(html.indexOf('queued-message-actions'));
    expect(html.indexOf('Move queued message up')).toBeLessThan(html.indexOf('Edit queued message'));
    expect(html.indexOf('Edit queued message')).toBeLessThan(html.indexOf('Remove queued message'));
    expect(html.indexOf('Remove queued message')).toBeLessThan(html.indexOf('Send queued message now'));
    expect(openingButton(html, 'Move queued message up')).toContain('size-8');
    expect(openingButton(html, 'Move queued message down')).toContain('size-8');
    expect(openingSlot(html, 'queued-message-icon-actions')).toContain('gap-1.5');
    expect(openingSlot(html, 'queued-message-actions')).toContain('gap-2');
  });

  it('disables both move controls for a one-message queue', () => {
    const html = render();
    expect(openingButton(html, 'Move queued message up')).toContain('disabled=""');
    expect(openingButton(html, 'Move queued message down')).toContain('disabled=""');
  });

  it('enables only the valid arrow at each queue boundary', () => {
    const first = render({ index: 0, count: 3 });
    expect(openingButton(first, 'Move queued message up')).toContain('disabled=""');
    expect(openingButton(first, 'Move queued message down')).not.toContain('disabled=""');

    const last = render({ index: 2, count: 3 });
    expect(openingButton(last, 'Move queued message up')).not.toContain('disabled=""');
    expect(openingButton(last, 'Move queued message down')).toContain('disabled=""');
  });

  it('hides all queue mutations from viewers who cannot manage the chat', () => {
    const html = render({ canManage: false });
    expect(html).toContain('Queued · sends after this reply');
    expect(html).not.toContain('Send now');
    expect(html).not.toContain('aria-label="Edit queued message"');
    expect(html).not.toContain('aria-label="Remove queued message"');
    expect(html).not.toContain('Move queued message up');
  });

  it('blocks pull-back editing while the composer already has a draft', () => {
    const html = render({ draftBlocked: true });
    const edit = openingButton(html, 'Edit queued message');
    expect(edit).toContain('disabled=""');
    expect(edit).toContain('title="Clear the composer to edit a queued message"');
  });

  it('shows the selected row as sending and disables every send-now action', () => {
    const selected = render({ sendingId: 1 });
    expect(selected).toContain('Sending…');
    expect(selected).not.toContain('>Send now<');
    expect(openingButton(selected, 'Send queued message now')).toContain('disabled=""');

    const other = render({ item: { ...item, id: 2 }, sendingId: 1 });
    expect(other).toContain('Send now');
    expect(openingButton(other, 'Send queued message now')).toContain('disabled=""');
  });
});

describe('QueuedMessageText', () => {
  it('clamps multi-line prompts without truncating their source text', () => {
    const text = 'Morning coffee steam\nrises past the laptop screen\nI forget my mug';
    const html = renderToStaticMarkup(<QueuedMessageText text={text} />);
    expect(html).toContain('Morning coffee steam');
    expect(html).toContain('rises past the laptop screen');
    expect(html).toContain('I forget my mug');
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).not.toContain('truncate');
  });

  it('makes overflowing text accessible and caps the expanded view', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
    const collapsed = renderToStaticMarkup(<QueuedMessageText text={text} open={false} />);
    const opened = renderToStaticMarkup(<QueuedMessageText text={text} open />);
    expect(collapsed).toContain('line-clamp-2');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Expand queued message"');
    expect(collapsed).toContain('role="button"');
    expect(opened).toContain('max-h-[min(40dvh,24rem)]');
    expect(opened).toContain('overflow-y-auto');
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain('aria-label="Collapse queued message"');
    expect(queuedPeekTextClass(true)).toContain('max-h-[min(40dvh,24rem)]');
    expect(queuedPeekTextClass(false)).toContain('line-clamp-2');
  });
});

describe('SteeredMessageRow', () => {
  it('reads as an ordinary sent bubble the bot will read at its next step', () => {
    const html = renderToStaticMarkup(<SteeredMessageRow text="also add tracking" />);
    expect(html).toContain('also add tracking');
    expect(html).toContain('Sent · reading at its next step');
    expect(html).not.toContain('opacity-60');
    expect(html).not.toContain('Send now');
    expect(html).not.toContain('Queued');
  });

  it('shows Sending while the steer request is in flight', () => {
    expect(renderToStaticMarkup(<SteeredMessageRow text="one more" sending />)).toContain('Sending…');
  });
});
