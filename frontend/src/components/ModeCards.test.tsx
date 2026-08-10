import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeCards } from './ModeCards';
import type { EtaEstimate } from '../api/jobs';

function estimate(overrides: Partial<EtaEstimate> = {}): EtaEstimate {
  return {
    mode: 'survey',
    estimateMinutes: 25,
    lowerMinutes: 20,
    upperMinutes: 30,
    basis: 'blended',
    sampleCount: 5,
    modelSampleCount: 5,
    modelAdjustment: 1,
    windowDays: 90,
    ...overrides,
  };
}

describe('ModeCards', () => {
  it('selects survey when its card is clicked', async () => {
    const onChange = vi.fn();
    render(<ModeCards value="baseline" onChange={onChange} />);
    await userEvent.click(screen.getByText(/survey/i));
    expect(onChange).toHaveBeenCalledWith('survey');
  });

  it('renders "--" for a mode whose estimate has not resolved yet, never a locally-computed number', () => {
    render(<ModeCards value="baseline" onChange={vi.fn()} />);
    // Both cards must show the placeholder -- neither estimate is passed.
    expect(screen.getAllByText('--')).toHaveLength(2);
  });

  it('renders the server-provided range for a mode whose estimate has resolved, not a hardcoded string', () => {
    render(
      <ModeCards
        value="survey"
        onChange={vi.fn()}
        baselineEstimate={estimate({ mode: 'baseline', estimateMinutes: 1, lowerMinutes: 1, upperMinutes: 1, basis: 'bootstrap' })}
        surveyEstimate={estimate({ lowerMinutes: 20, upperMinutes: 30 })}
      />,
    );
    // BASELINE: lower===upper -> no "typically" framing (it's flat, not a projection).
    expect(screen.getByText('1 min')).toBeInTheDocument();
    // SURVEY: a real range, framed as an estimate, not a false-precision point value.
    expect(screen.getByText('20 min – 30 min, typically')).toBeInTheDocument();
  });

  it('does not switch the selected mode when Enter/Space opens the nested model dropdown on the SURVEY card', async () => {
    // Real bug found on review: the SURVEY card is a role="radio" DIV (not
    // a <button>, since it nests a real Select whose own Radix trigger is a
    // <button> -- a button can't nest a button) with its own onKeyDown
    // treating Enter/Space as "select this mode." Radix's SelectTrigger
    // only ever calls preventDefault() on those same keys, never
    // stopPropagation() -- confirmed against @radix-ui/react-select's own
    // source -- so without an explicit stopPropagation guard around the
    // model picker, pressing Enter/Space to OPEN the dropdown bubbled
    // straight up and silently fired onChange('survey') as a side effect,
    // even while BASELINE was the one actually selected.
    const onChange = vi.fn();
    render(
      <ModeCards value="baseline" onChange={onChange} model="" onModelChange={vi.fn()} availableModels={['qwen2.5:32b']} />,
    );
    const modelTrigger = screen.getByRole('combobox', { name: 'LLM Model' });
    modelTrigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
  });
});
