import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentsPage } from './AgentsPage';

describe('Agents settings', () => {
  it('offers agent creation while data is loading', () => {
    const html = renderToStaticMarkup(<AgentsPage />);
    expect(html).toContain('New agent');
  });
});
