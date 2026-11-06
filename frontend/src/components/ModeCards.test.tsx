import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeCards } from './ModeCards';
import type { EtaEstimate, ModelDetail } from '../api/jobs';

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

  describe('model facts', () => {
    const details: ModelDetail[] = [
      { id: 'claude-x', name: 'Claude X', describesFigures: true, runs: 12, speedVsTypical: 0.8, finishedShare: 0.9 },
      { id: 'small', name: 'Small', describesFigures: false, runs: 0, speedVsTypical: null, finishedShare: null },
    ];
    const renderCards = (props: Record<string, unknown> = {}) =>
      render(
        <ModeCards value="survey" onChange={vi.fn()} model="" onModelChange={vi.fn()} availableModels={['claude-x', 'small']}
          modelDetails={details} recommendedModel="claude-x" {...props} />,
      );

    const openPicker = async () => {
      screen.getByRole('combobox', { name: 'LLM Model' }).focus();
      await userEvent.keyboard('{Enter}');
    };

    it('marks the recommended model in the list and names it on the Default option', async () => {
      renderCards();
      await openPicker();
      expect(screen.getByRole('option', { name: 'claude-x · Recommended' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'small' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Default (claude-x)' })).toBeInTheDocument();
    });

    it('states the facts of the chosen model under the picker', () => {
      renderCards({ model: 'small' });
      expect(screen.getByText('Skips figures · Not enough runs yet on this deployment')).toBeInTheDocument();
    });

    it('states the facts of the model Default resolves to when Default is selected', () => {
      renderCards({ model: '' });
      expect(screen.getByText(/Describes figures · about 20% faster than typical here \(from 12 recent runs\) · 90% of runs finished/)).toBeInTheDocument();
    });

    it('renders the plain list when the server sent no details or recommendation', async () => {
      renderCards({ modelDetails: undefined, recommendedModel: undefined });
      await openPicker();
      expect(screen.getByRole('option', { name: 'claude-x' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Default' })).toBeInTheDocument();
      expect(screen.queryByText(/(Describes|Skips) figures/)).not.toBeInTheDocument();
    });
  });

  it('explains what the SURVEY estimate is based on, and says nothing extra for BASELINE', () => {
    render(
      <ModeCards
        value="survey"
        onChange={vi.fn()}
        baselineEstimate={estimate({ mode: 'baseline', estimateMinutes: 1, lowerMinutes: 1, upperMinutes: 1, basis: 'bootstrap', sampleCount: 0 })}
        surveyEstimate={estimate({ sampleCount: 7, modelSampleCount: 0 })}
      />,
    );
    expect(screen.getByText('Based on 7 completed jobs in the last 90 days')).toBeInTheDocument();
    expect(screen.queryByText(/Rough guess/)).not.toBeInTheDocument();
  });
});
