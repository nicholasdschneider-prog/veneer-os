import type { PageBrand } from './api';

/**
 * Site-brand tint. The generated CSS is mirrored to localStorage and applied
 * pre-paint by index.html — keep the key and behavior in sync. Base token
 * literals mirror styles.css — keep those values in sync too.
 */

const STORAGE_KEY = 'vp-brand-css';
const STYLE_ID = 'vp-brand-style';
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function brandCss(brand: PageBrand): string | null {
  if (brand.applyToApp === false) return null;
  const accent = brand.accentColor.trim();
  const primary = brand.primaryColor.trim();
  const color = HEX_COLOR.test(accent) ? accent : HEX_COLOR.test(primary) ? primary : null;
  if (!color) return null;

  return `:root:not([data-theme]) {
  --brand: ${color};
  --ring: ${color};
  --shell-rail: color-mix(in oklab, ${color} 5%, #ebecee);
  --shell-sidebar: color-mix(in oklab, ${color} 4%, #f3f4f5);
  --background: color-mix(in oklab, ${color} 3%, #fafafa);
  --secondary: color-mix(in oklab, ${color} 6%, #e9eaec);
  --muted: color-mix(in oklab, ${color} 6%, #e9eaec);
  --accent: color-mix(in oklab, ${color} 6%, #e9eaec);
  --border: color-mix(in oklab, ${color} 8%, #dcdee1);
  --input: color-mix(in oklab, ${color} 8%, #dcdee1);
}
:root[data-color-mode='dark']:not([data-theme]) {
  --brand: color-mix(in oklab, ${color} 60%, #f2f4f6);
  --ring: color-mix(in oklab, ${color} 60%, #f2f4f6);
  --shell-rail: color-mix(in oklab, ${color} 3%, #14171b);
  --shell-sidebar: color-mix(in oklab, ${color} 5%, #20242a);
  --background: color-mix(in oklab, ${color} 4%, #191c21);
  --secondary: color-mix(in oklab, ${color} 6%, #30353d);
  --muted: color-mix(in oklab, ${color} 6%, #30353d);
  --accent: color-mix(in oklab, ${color} 6%, #30353d);
  --border: color-mix(in oklab, ${color} 8%, #3a4048);
  --input: color-mix(in oklab, ${color} 8%, #3a4048);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]):not([data-color-mode]) {
    --brand: color-mix(in oklab, ${color} 60%, #f2f4f6);
    --ring: color-mix(in oklab, ${color} 60%, #f2f4f6);
    --shell-rail: color-mix(in oklab, ${color} 3%, #14171b);
    --shell-sidebar: color-mix(in oklab, ${color} 5%, #20242a);
    --background: color-mix(in oklab, ${color} 4%, #191c21);
    --secondary: color-mix(in oklab, ${color} 6%, #30353d);
    --muted: color-mix(in oklab, ${color} 6%, #30353d);
    --accent: color-mix(in oklab, ${color} 6%, #30353d);
    --border: color-mix(in oklab, ${color} 8%, #3a4048);
    --input: color-mix(in oklab, ${color} 8%, #3a4048);
  }
}`;
}

export function applyBrand(brand: PageBrand): void {
  const css = brandCss(brand);
  const existing = document.getElementById(STYLE_ID);
  if (css) {
    const style = existing ?? document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  } else {
    existing?.remove();
  }

  try {
    if (css) localStorage.setItem(STORAGE_KEY, css);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal: brand tint just won't persist pre-paint */
  }
}
