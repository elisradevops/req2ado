import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  // A popover wider than its trigger sat on top of the next field's label
  // (review finding V3): the list is no wider than the trigger (14rem floor), and a long
  // option wraps instead of widening it.
  it('sizes the popover to the trigger (14rem floor) and wraps long options', async () => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
    const long = 'A deliberately very long model name that would otherwise widen the list';
    render(
      <Select label="Model" value="a">
        <option value="a">{long}</option>
      </Select>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    const option = await screen.findByRole('option');
    const content = option.closest('[data-radix-popper-content-wrapper] > *') as HTMLElement;
    expect(content.className).toContain('w-[max(var(--radix-select-trigger-width),14rem)]');
    expect(content.className).not.toContain('min-w-');
    expect(option.querySelector('.break-words')).not.toBeNull();
    expect(option.querySelector('.truncate')).toBeNull();
  });
});
