import { describe, expect, it } from 'vitest';
import type { PageBrand } from './api';
import { brandCss } from './brandTheme';

const BRAND: PageBrand = {
  primaryColor: '',
  accentColor: '',
  backgroundColor: '',
  font: '',
  headingFont: '',
  notes: '',
  applyToApp: true,
};

function brand(patch: Partial<PageBrand>): PageBrand {
  return { ...BRAND, ...patch };
}

describe('brandCss', () => {
  it('returns null when app tinting is disabled or no valid color is set', () => {
    expect(brandCss(brand({ accentColor: '#123', applyToApp: false }))).toBeNull();
    expect(brandCss(brand({}))).toBeNull();
    expect(brandCss(brand({ accentColor: 'blue', primaryColor: 'also-blue' }))).toBeNull();
  });

  it('prefers a valid accent color over the primary color', () => {
    const css = brandCss(brand({ primaryColor: '#112233', accentColor: '#aBc' }));
    expect(css).toContain('#aBc');
    expect(css).not.toContain('#112233');
  });

  it('scopes the tint away from named themes and includes a dark-mode variant', () => {
    const css = brandCss(brand({ primaryColor: '#123456' }));
    expect(css).toContain(':root:not([data-theme])');
    expect(css).toContain(":root[data-color-mode='dark']:not([data-theme])");
    expect(css).toContain(':root:not([data-theme]):not([data-color-mode])');
    expect(css).toContain('--shell-rail:');
    expect(css).toContain('--shell-sidebar:');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('#123456');
  });

  it('rejects hex-like values outside #rgb and #rrggbb', () => {
    expect(brandCss(brand({ accentColor: '#abcd' }))).toBeNull();
    expect(brandCss(brand({ primaryColor: '#1234567' }))).toBeNull();
  });
});
