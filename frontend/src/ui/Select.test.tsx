import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from './Select';

describe('Select', () => {
  it('shows a disabled Loading… trigger while options are being fetched', () => {
    render(
      <Select label="Model" value="" loading>
        <option value="">Default</option>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent('Loading…');
  });

  it('shows the selected value and is enabled when not loading', () => {
    render(
      <Select label="Model" value="a">
        <option value="a">Alpha</option>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).not.toBeDisabled();
    expect(trigger).not.toHaveTextContent('Loading…');
  });
});
