import { describe, expect, it } from 'vitest';
import { DESKTOP_QUERY } from './useMediaQuery';

describe('DESKTOP_QUERY', () => {
  it('requires enough height so landscape phones keep the mobile shell', () => {
    expect(DESKTOP_QUERY).toContain('(min-width: 768px)');
    expect(DESKTOP_QUERY).toContain('(min-height: 600px)');
  });
});
