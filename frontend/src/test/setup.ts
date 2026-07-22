import '@testing-library/jest-dom';

// jsdom has no ResizeObserver -- DiffTree's VariableSizeList row measurement
// (see DiffTree.tsx's MeasuredRow) requires one to exist at all, even though
// jsdom can't produce real layout/size values.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
