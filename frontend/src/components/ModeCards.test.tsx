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
  it('says a cached file takes a few seconds on the SURVEY card, instead of a range that contradicts the side panel', () => {
    render(<ModeCards value="survey" onChange={vi.fn()} baselineEstimate={estimate({ mode: 'baseline', lowerMinutes: 1, upperMinutes: 1 })} surveyEstimate={estimate()} surveyCached />);
    const card = screen.getByRole('radio', { name: /With AI review/ });
    expect(card).toHaveTextContent('A few seconds');
    expect(card).toHaveTextContent('this file was already processed');
    expect(card).not.toHaveTextContent('20 min');
    expect(card).not.toHaveTextContent('Based on');
  });

  it('keeps the measured range on the SURVEY card when the file is not cached', () => {
    render(<ModeCards value="survey" onChange={vi.fn()} baselineEstimate={estimate({ mode: 'baseline', lowerMinutes: 1, upperMinutes: 1 })} surveyEstimate={estimate()} />);
    expect(screen.getByRole('radio', { name: /With AI review/ })).toHaveTextContent('20 min – 30 min, typically');
  });

  it('selects survey when its card is clicked', async () => {
    const onChange = vi.fn();
    render(<ModeCards value="baseline" onChange={onChange} />);
    await userEvent.click(screen.getByText('With AI review'));
    expect(onChange).toHaveBeenCalledWith('survey');
  });

  it('labels the last-used mode only: the label never selects that card or calls onChange', () => {
    const onChange = vi.fn();
    render(<ModeCards value="baseline" onChange={onChange} lastUsed="survey" />);
    const survey = screen.getByRole('radio', { name: /With AI review/ });
    expect(survey).toHaveTextContent('Last used');
    expect(survey).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Standard/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Standard/ })).not.toHaveTextContent('Last used');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows no label without a last-used mode', () => {
    render(<ModeCards value="baseline" onChange={vi.fn()} />);
    expect(screen.queryByText('Last used')).not.toBeInTheDocument();
  });

  it('names the modes as the owner did and says both read the file with AI (2026-11-25)', () => {
    render(<ModeCards value="baseline" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /Standard/ })).toHaveTextContent("The file's own structure and text, with clean titles.");
    expect(screen.getByRole('radio', { name: /With AI review/ })).toHaveTextContent('plus scoring, acceptance criteria and wording suggestions');
    expect(screen.getByText('Both modes use AI to read the file.')).toBeInTheDocument();
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

  it('keeps the model picker outside the cards, so opening it from the keyboard never changes the mode', async () => {
    const onChange = vi.fn();
    render(<ModeCards value="survey" onChange={onChange} model="" onModelChange={vi.fn()} availableModels={['qwen2.5:32b']} />);
    const modelTrigger = screen.getByRole('combobox', { name: 'AI model' });
    expect(modelTrigger.closest('[role="radio"]')).toBeNull();
    modelTrigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the model picker only with the AI review chosen', () => {
    render(<ModeCards value="baseline" onChange={vi.fn()} model="" onModelChange={vi.fn()} availableModels={['qwen2.5:32b']} />);
    expect(screen.queryByRole('combobox', { name: 'AI model' })).toBeNull();
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
      screen.getByRole('combobox', { name: 'AI model' }).focus();
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

  it('shows the SURVEY range only: the basis is stated once, in the summary rail', () => {
    render(
      <ModeCards
        value="survey"
        onChange={vi.fn()}
        baselineEstimate={estimate({ mode: 'baseline', estimateMinutes: 1, lowerMinutes: 1, upperMinutes: 1, basis: 'bootstrap', sampleCount: 0 })}
        surveyEstimate={estimate({ sampleCount: 7, modelSampleCount: 0 })}
      />,
    );
    expect(screen.queryByText(/Based on 7 completed jobs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Rough guess/)).not.toBeInTheDocument();
  });

  it('shows no output example: the cards are compact, a name, a time and one line (the approved mockup)', () => {
    render(<ModeCards value="baseline" onChange={vi.fn()} baselineEstimate={undefined} surveyEstimate={undefined} />);
    expect(screen.queryByText(/Example of what lands in Azure DevOps/)).toBeNull();
    expect(screen.queryByText('<short title>')).toBeNull();
  });
});
