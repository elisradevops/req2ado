import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Tabs } from './Tabs';

const TABS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

function Harness({ withChildren }: { withChildren: boolean }): React.ReactElement {
  const [value, setValue] = useState('a');
  return (
    <Tabs value={value} onValueChange={setValue} tabs={TABS}>
      {withChildren ? <p>Panel {value}</p> : undefined}
    </Tabs>
  );
}

describe('Tabs', () => {
  it('points the selected tab at a mounted tabpanel named by that tab', () => {
    render(<Harness withChildren />);
    const trigger = screen.getByRole('tab', { name: 'Alpha' });
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel).toBe(screen.getByRole('tabpanel', { name: 'Alpha' }));
    expect(panel).toHaveTextContent('Panel a');
  });

  it('keeps aria-controls resolvable after switching tab', async () => {
    render(<Harness withChildren />);
    await userEvent.click(screen.getByRole('tab', { name: 'Beta' }));
    const trigger = screen.getByRole('tab', { name: 'Beta' });
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(
      screen.getByRole('tabpanel', { name: 'Beta' }),
    );
  });

  it('adds no keyboard stop of its own: the panel holds focusable content, so it stays out of the tab order', () => {
    render(<Harness withChildren />);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('tabindex', '-1');
  });

  it('still mounts the panel when the caller renders its content elsewhere', () => {
    render(<Harness withChildren={false} />);
    const trigger = screen.getByRole('tab', { name: 'Alpha' });
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull();
  });
});
