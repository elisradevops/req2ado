import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';

// Default asyncUtilTimeout (1000ms) for findBy*/waitFor is tuned for a fast
// local machine. This repo's own CI (first real run: 2026-08-31) surfaced
// intermittent findByRole/waitFor timeouts in a rotating set of frontend
// tests -- root-caused (see vitest.config.ts's testTimeout comment) to real
// CPU contention on a resource-constrained runner, not any specific test's
// logic: reproduced live in a deliberately oversubscribed container where a
// DIFFERENT unrelated test timed out each run. Widened alongside
// testTimeout so the inner findBy*/waitFor budget doesn't become the
// binding constraint once the outer per-test budget was raised.
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
