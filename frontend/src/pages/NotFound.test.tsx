import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFound } from './NotFound';

describe('NotFound', () => {
  it('has the one page title at the page-title size and names the address that was not found', () => {
    render(<MemoryRouter initialEntries={['/kb']}><NotFound /></MemoryRouter>);
    const title = screen.getByRole('heading', { level: 1, name: 'Page not found' });
    expect(title.className).toMatch(/(^| )text-display( |$)/);
    expect(screen.getByText('/kb')).toBeInTheDocument();
  });

  it('gives a way forward (DESIGN.md §12: an error state invites an action)', () => {
    render(<MemoryRouter><NotFound /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Go to jobs' })).toHaveAttribute('href', '/jobs');
    expect(screen.getByRole('link', { name: 'Open the knowledge base' })).toHaveAttribute('href', '/knowledge-base');
  });
});
