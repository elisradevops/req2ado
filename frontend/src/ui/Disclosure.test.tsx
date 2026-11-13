import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Disclosure } from './Disclosure';

describe('Disclosure (DESIGN.md §7, §11.3.2b: one chevron, one set of mechanics)', () => {
  it('is closed by default, with a button that says so and nothing of its content in the page', () => {
    render(<Disclosure title="Run details"><p>the stepper</p></Disclosure>);
    const trigger = screen.getByRole('button', { name: /Run details/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('the stepper')).not.toBeInTheDocument();
  });

  it('opens and closes on click, and points at the region it controls', async () => {
    render(<Disclosure title="Run details"><p>the stepper</p></Disclosure>);
    const trigger = screen.getByRole('button', { name: /Run details/ });
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: /Run details/ });
    expect(trigger).toHaveAttribute('aria-controls', region.id);
    await userEvent.click(trigger);
    // closed: it must not point at an element that is not in the page
    expect(trigger).not.toHaveAttribute('aria-controls');
    await userEvent.click(trigger);
    expect(region).toHaveTextContent('the stepper');
    await userEvent.click(trigger);
    expect(screen.queryByText('the stepper')).not.toBeInTheDocument();
  });

  it('shows the same chevron whether or not it has a summary, and turns it when open', async () => {
    const { container } = render(<Disclosure title="Run details" summary="18 new · 0 reused"><p>x</p></Disclosure>);
    const chevron = container.querySelector('svg');
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron!.getAttribute('class')).not.toMatch(/rotate-90/);
    await userEvent.click(screen.getByRole('button'));
    expect(container.querySelector('svg')!.getAttribute('class')).toMatch(/rotate-90/);
  });

  it('puts the summary in the same button as the title, so one click target covers the whole strip', () => {
    render(<Disclosure title="Run details" summary="18 new · 0 reused"><p>x</p></Disclosure>);
    expect(screen.getByRole('button', { name: /Run details.*18 new · 0 reused/ })).toBeInTheDocument();
  });

  it('can start open', () => {
    render(<Disclosure title="Run details" defaultOpen><p>the stepper</p></Disclosure>);
    expect(screen.getByRole('button', { name: /Run details/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('the stepper')).toBeInTheDocument();
  });
});
