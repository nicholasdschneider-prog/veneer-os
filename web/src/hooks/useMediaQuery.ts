import { useEffect, useState } from 'react';

/** Desktop panes need both tablet width and enough height to remain usable.
 * Keep this in sync with the `--vp-nav-h` media query in styles.css. */
export const DESKTOP_QUERY = '(min-width: 768px) and (min-height: 600px)';

/** Live media-query match (re-renders on change, e.g. window resize). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
