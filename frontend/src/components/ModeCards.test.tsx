import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeCards } from './ModeCards';

describe('ModeCards', () => {
  it('selects survey when its card is clicked', async () => {
    const onChange = vi.fn();
    render(<ModeCards value="baseline" onChange={onChange} />);
    await userEvent.click(screen.getByText(/survey/i));
    expect(onChange).toHaveBeenCalledWith('survey');
  });
});
