import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';

export interface VisualViewportLike {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

export function visualViewportStyle(viewport: VisualViewportLike | null): CSSProperties | undefined {
  if (!viewport) return undefined;
  return {
    inset: 'auto',
    left: `${viewport.offsetLeft}px`,
    top: `${viewport.offsetTop}px`,
    width: `${viewport.width}px`,
    height: `${viewport.height}px`,
  };
}

/** Keeps fixed overlays inside Safari's keyboard-sized visual viewport. */
export function useVisualViewportBounds(): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>();
  const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

  useIsoLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      setStyle(undefined);
      return;
    }
    const update = () => setStyle(visualViewportStyle(viewport));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return style;
}
