// The integrity-warnings card starts folded to its header line on a job awaiting review (DESIGN.md §11.3.5). Most JobDetail tests are about
// the rows inside it, so they open it the way a reviewer does: by pressing its header, as soon as it appears. A test of the folded default
// passes nothing of this to its render.
export function autoOpenWarnings(): () => void {
  const openIfFolded = (): void => {
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('section[aria-label="Integrity warnings"] > button[aria-expanded="false"]'))) {
      button.click();
    }
  };
  const observer = new MutationObserver(openIfFolded);
  observer.observe(document.body, { childList: true, subtree: true });
  openIfFolded();
  return () => observer.disconnect();
}
