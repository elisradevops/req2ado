import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnimatedNumber } from './AnimatedNumber';

// number-flow is mocked in test/setup.ts (jsdom cannot render its shadow root), so this checks the structure around it; the
// real digit-by-digit reading is only visible in a browser (e2e/tests/review-hierarchy.spec.ts).
describe('AnimatedNumber', () => {
  it('hides the animation from assistive tech and gives it the plain number instead', () => {
    const { container } = render(
      <button type="button">
        Clean · <AnimatedNumber value={1235} />
      </button>,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName('Clean · 1,235');
    const hidden = container.querySelector('[aria-hidden="true"]');
    expect(hidden).not.toBeNull();
    expect(screen.getByText('1,235')).toHaveClass('sr-only');
    expect(hidden).not.toContainElement(screen.getByText('1,235'));
  });

  it('says the number once', () => {
    render(
      <p>
        <AnimatedNumber value={2} /> items to fix
      </p>,
    );
    expect(screen.getByText('items to fix', { exact: false })).toHaveTextContent(/^2 items to fix$/);
  });
});
