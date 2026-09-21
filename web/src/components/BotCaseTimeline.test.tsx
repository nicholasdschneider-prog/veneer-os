import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotCaseTimeline } from './BotCaseTimeline';

describe('case history highlights', () => {
  it('preserves date precision, attribution, promises and uncertainty', () => {
    const html = renderToStaticMarkup(<BotCaseTimeline entries={[
      { when: 'Aug 24 (year unknown)', actor: 'Ryan', channel: 'SMS', kind: 'request', summary: 'Asked for a $1,199 refund; receipt of the AC is disputed.', source: 'SMS ticket 123, customer message' },
      { when: null, actor: 'Support', bot: 'Miles', kind: 'promise', summary: 'Said another package would be sent. Shipment not verified.', source: 'Reply in ticket 123' },
    ]} />);
    expect(html).toContain('Aug 24 (year unknown)');
    expect(html).toContain('Date unknown');
    expect(html).toContain('Handled by Miles');
    expect(html).toContain('Requested:');
    expect(html).toContain('Promised:');
    expect(html).toContain('Shipment not verified.');
    expect(html).toContain('SMS ticket 123, customer message');
  });
  it('does not invent customer events for legacy cards', () => {
    expect(renderToStaticMarkup(<BotCaseTimeline />)).toContain('Case history hasn’t been recorded');
    expect(renderToStaticMarkup(<BotCaseTimeline entries={[]} />)).not.toContain('<li');
  });
});
