import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Default asyncUtilTimeout (1000ms) for findBy*/waitFor is tuned for a fast
// local machine -- this repo's own CI (first real run: 2026-08-31) surfaced
// intermittent findByRole timeouts in JobDetail.test.tsx that never
// reproduce locally (confirmed: 5/5 clean local runs of the same file, same
// tests, no flake), consistent with GitHub Actions' shared/throttled vCPU
// runners needing more wall-clock time for the same React
// render+effect+portal-mount work, not a real product race. Widened
// globally rather than per-test since the specific test that times out
// varies run to run -- it's the runner's speed variance, not one test's
// logic.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no ResizeObserver -- DiffTree's VariableSizeList row measurement
// (see DiffTree.tsx's MeasuredRow) requires one to exist at all, even though
// jsdom can't produce real layout/size values.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

// jsdom implements neither the pointer-capture trio nor scrollIntoView --
// Radix Select's trigger/viewport call these unconditionally, so without
// stubs every test that opens a Select throws before it can assert anything.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no matchMedia -- NodeDetailDialog's useIsAboveBreakpoint hook
// (gates which layout variant actually MOUNTS, not just CSS visibility --
// see its own doc comment) calls it unconditionally on every render.
// Defaults to non-matching (mobile/tabbed layout) since jsdom has no real
// viewport width; tests asserting desktop-layout behavior stub this
// per-test instead.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
