import NumberFlow from '@number-flow/react';

// A count that rolls to its new value instead of snapping -- for the few
// numbers a reviewer is actively driving down ("52 left of 80"), where the
// change IS the feedback. Everything else stays a plain number.
//
// number-flow honours prefers-reduced-motion itself (it snaps), and renders
// the formatted value into an accessible label, so a screen reader still
// reads the number.
export function AnimatedNumber({ value }: { value: number }): React.ReactElement {
  return <NumberFlow value={value} />;
}
