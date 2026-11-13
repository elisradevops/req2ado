import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafetyLine, RUNNING_SAFETY_TEXT, WIZARD_SAFETY_TEXT } from './SafetyLine';

describe('SafetyLine', () => {
  it('says the §0 wizard line verbatim', () => {
    render(<SafetyLine variant="wizard" />);
    expect(screen.getByText('Nothing reaches Azure DevOps until you approve the proposed diff.')).toBeInTheDocument();
    expect(WIZARD_SAFETY_TEXT).toBe('Nothing reaches Azure DevOps until you approve the proposed diff.');
  });

  it('says the §0 running-screen line verbatim', () => {
    render(<SafetyLine variant="running" />);
    expect(
      screen.getByText('Nothing has been written to Azure DevOps. Writing only starts after you approve the diff.'),
    ).toBeInTheDocument();
    expect(RUNNING_SAFETY_TEXT).toBe('Nothing has been written to Azure DevOps. Writing only starts after you approve the diff.');
  });

  it('hides its lock glyph from assistive technology and never uses the signal colour', () => {
    const { container } = render(<SafetyLine variant="running" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.innerHTML).not.toMatch(/signal/);
  });
});
