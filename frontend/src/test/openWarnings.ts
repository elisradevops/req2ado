import { act } from '@testing-library/react';

// The integrity-warnings card starts folded to its header line on a job awaiting review (DESIGN.md §11.3.5). Most JobDetail tests are about
// the rows inside it, so they open it the way a reviewer does, by pressing its header, the moment it appears folded. A MutationObserver runs
// right after the DOM change and the press is wrapped in act(), so the opened rows are rendered before a test's next line reads them. A poll
// stays as a backstop for a card the page mounts again while it loads. A test of the folded default passes `keepWarningsFolded` to its render.
export function autoOpenWarnings(): () => void {
  const openIfFolded = (): void => {
    const folded = Array.from(
      document.querySelectorAll<HTMLButtonElement>('section[aria-label="Integrity warnings"] > button[aria-expanded="false"]'),
    );
    if (folded.length === 0) return;
    act(() => {
      for (const button of folded) button.click();
    });
  };
  const observer = new MutationObserver(openIfFolded);
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setInterval(openIfFolded, 25);
  openIfFolded();
  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
}
