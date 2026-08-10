import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): React.ReactElement {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders a fallback instead of crashing the whole app', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // DESIGN.md §12 bans "Something went wrong" -- real copy states cause
    // then remedy instead.
    expect(screen.getByText(/hit an error while rendering/i)).toBeInTheDocument();
    expect(screen.getByText(/reloading usually fixes it/i)).toBeInTheDocument();
  });
});
