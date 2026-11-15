import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TextField } from './TextField';
import { Select } from './Select';
import { Combobox } from './Combobox';

// Tailwind 4: `outline-none` sets the outline style to none, and `focus-visible:outline-2` only sets a width that reads that style, so a field
// with both draws no ring (seen live on the text filter and the Select trigger). `focus-visible:outline-solid` brings the style back.
const hasClass = (element: HTMLElement, name: string): boolean => element.className.split(/\s+/).includes(name);

describe('field focus rings (DESIGN.md section 7)', () => {
  it('TextField draws its ring when focus-visible', () => {
    render(<TextField label="Name" />);
    const input = screen.getByLabelText('Name');
    expect(hasClass(input, 'focus-visible:outline-2')).toBe(true);
    expect(hasClass(input, 'focus-visible:outline-solid')).toBe(true);
  });

  it('Select draws its ring when focus-visible', () => {
    render(
      <Select label="Model" value="a">
        <option value="a">Alpha</option>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(hasClass(trigger, 'focus-visible:outline-2')).toBe(true);
    expect(hasClass(trigger, 'focus-visible:outline-solid')).toBe(true);
  });

  it('Combobox draws its ring when focus-visible', () => {
    render(<Combobox label="Area path" value="" onChange={() => {}} options={['A']} />);
    const input = screen.getByRole('combobox');
    expect(hasClass(input, 'focus-visible:outline-2')).toBe(true);
    expect(hasClass(input, 'focus-visible:outline-solid')).toBe(true);
  });
});
