// The integrity-warnings card starts folded to its header line on a job awaiting review (DESIGN.md §11.3.5). Most JobDetail tests are about
// the rows inside it, so they open it the way a reviewer does: by pressing its header, as soon as it shows up folded. It polls rather than
// observing the DOM: the page mounts the card more than once while it loads, and a poll opens whichever one is there. A test of the folded
// default passes `keepWarningsFolded` to its render and gets none of this.
export function autoOpenWarnings(): () => void {
  const openIfFolded = (): void => {
    for (const button of Array.from(
      document.querySelectorAll<HTMLButtonElement>('section[aria-label="Integrity warnings"] > button[aria-expanded="false"]'),
    )) {
      button.click();
    }
  };
  openIfFolded();
  const timer = setInterval(openIfFolded, 10);
  return () => clearInterval(timer);
}
