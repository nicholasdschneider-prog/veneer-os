import { describe, expect, it } from 'vitest';
import { applyPageTitle, pageTitle } from './pageTitle.js';

describe('Veneer Pro page title', () => {
  it('includes a fleet client display name', () => {
    expect(pageTitle('Acme')).toBe('Veneer Pro — Acme');
  });

  it('stays generic for the primary Platform install', () => {
    expect(pageTitle(null)).toBe('Veneer Pro');
    expect(pageTitle('   ')).toBe('Veneer Pro');
  });

  it('updates the document title target', () => {
    const target = { title: 'Veneer Pro' };
    applyPageTitle('Acme', target);
    expect(target.title).toBe('Veneer Pro — Acme');
  });
});
