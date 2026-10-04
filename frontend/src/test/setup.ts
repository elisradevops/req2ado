import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// Default asyncUtilTimeout (1000ms) for findBy*/waitFor is tuned for a fast
// local machine. This repo's own CI (first real run: 2026-08-31) surfaced
// intermittent findByRole/waitFor timeouts in a rotating set of frontend
// tests -- root-caused (see vitest.config.ts's testTimeout comment) to real
// CPU contention on a resource-constrained runner, not any specific test's
// logic: reproduced live in a deliberately oversubscribed container where a
// DIFFERENT unrelated test timed out each run.
//
// First widened to 5000ms, but that created a NEW, real race: ToastProvider
// renders with a 4400ms auto-dismiss duration, so a 5000ms findBy*/waitFor
// window can watch a real toast appear AND fully disappear before deciding
// it was never there -- confirmed live as the cause of a CI-only failure
// ("shows an error toast when toggling exclude fails"), independent of any
// CPU contention. 3000ms keeps real headroom over the 1000ms default for
// contention while staying safely under every toast's 4400ms shelf life.
configure({ asyncUtilTimeout: 3000 });

// jsdom does not implement HTMLCanvasElement.getContext -- DiffTree.tsx calls
// it for text-width measurement (getMeasurerContext). Without this stub jsdom
// throws "Not implemented: HTMLCanvasElement.prototype.getContext" on every
// render of DiffTree, flooding the test output and causing timing-sensitive
// act() failures on the slow CI runner. DiffTree already handles a null
// return from getContext gracefully (measureTextWidth returns 0), so returning
// null here is the correct and minimal stub.
HTMLCanvasElement.prototype.getContext = () => null;

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

// number-flow renders the digits into a shadow root with its own <style>,
// so a sentence like "28 of 80 reviewed" is split across elements and no
// longer matches getByText. Tests assert the numbers, not the roll
// animation -- render the plain formatted value as a bare text node.
vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => Number(value).toLocaleString(),
}));
