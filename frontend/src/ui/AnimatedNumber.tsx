import NumberFlow from '@number-flow/react';

// A count that rolls to its new value instead of snapping -- for the few
// numbers a reviewer is actively driving down ("52 left of 80"), where the
// change IS the feedback. Everything else stays a plain number.
//
// number-flow honours prefers-reduced-motion itself (it snaps). It draws the
// digits in a shadow root, which a screen reader reads digit column by digit
// column, so the animation is hidden from assistive tech and a visually
// hidden plain number carries the value instead ("Clean · 235" is read as a
// number, DESIGN.md §13).
export function AnimatedNumber({ value }: { value: number }): React.ReactElement {
  return (
    <>
      <span aria-hidden="true">
        <NumberFlow value={value} />
      </span>
      <span className="sr-only">{value.toLocaleString()}</span>
    </>
  );
}
