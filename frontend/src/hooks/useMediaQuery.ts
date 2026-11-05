import { useEffect, useState } from 'react';

/**
 * The `md` breakpoint exactly as Tailwind v4 compiles it (`min-width: 48rem`, `max-md` = `width < 48rem`). The JS side must use the same range
 * test as the CSS side: with `767px` / `768px` the two disagree on fractional widths (browser zoom), and a row then renders the desktop markup
 * under the phone grid.
 */
export const BELOW_MD = '(width < 48rem)';
export const AT_LEAST_MD = '(width >= 48rem)';

/** Whether a CSS media query currently matches, kept in step as the window changes. False where there is no `window`. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const listener = (event: MediaQueryListEvent): void => setMatches(event.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);

  return matches;
}
