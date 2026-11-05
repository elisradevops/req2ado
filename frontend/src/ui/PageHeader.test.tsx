import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders the title as the page\'s level-one heading', () => {
    render(<PageHeader title="Knowledge Base" description="Documents" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge Base' })).toBeInTheDocument();
  });
});
