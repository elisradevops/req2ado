import { useEffect } from 'react';

const PRODUCT = 'req2ado';

/** Sets the browser-tab title to "<page> - req2ado" while the page is mounted, and restores the previous one on leaving. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} - ${PRODUCT}`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
