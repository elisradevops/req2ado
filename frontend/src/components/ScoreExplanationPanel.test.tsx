import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScoreExplanationPanel } from './ScoreExplanationPanel';

const answer = (overrides: Record<string, unknown> = {}) => ({
  explanations: [
    { category: 'Verifiable', score: 20, reason: 'No limit is stated for "lock fast"; add a value and a unit.', passCondition: 'Has a measurable acceptance criterion' },
    { category: 'Unambiguous', score: 35, reason: null, passCondition: 'One reading only' },
  ],
  basis: 'built_in', rubric: { source: 'default', version: 'default-rubric-1' }, ...overrides,
});

describe('ScoreExplanationPanel', () => {
  it('asks only when the user does, and shows each reason with its score and what the category is held to', async () => {
    const load = vi.fn().mockResolvedValue(answer());
    render(<ScoreExplanationPanel load={load} resetKey="n0:60" />);
    expect(load).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/no limit is stated/i)).toBeInTheDocument();
    expect(screen.getByText('Verifiable')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText(/has a measurable acceptance criterion/i)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('says what the explanation is based on: the knowledge base or the built-in rubric', async () => {
    const load = vi.fn().mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer({ basis: 'knowledge_base', rubric: { source: 'kb', version: 'v' } }));
    const { rerender } = render(<ScoreExplanationPanel load={load} resetKey="a" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/based on the built-in rubric/i)).toBeInTheDocument();
    rerender(<ScoreExplanationPanel load={load} resetKey="b" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/based on your knowledge base/i)).toBeInTheDocument();
  });

  it('does not invent a reason the model did not give', async () => {
    render(<ScoreExplanationPanel load={vi.fn().mockResolvedValue(answer())} resetKey="n0" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/no reason was given for this category/i)).toBeInTheDocument();
  });

  it('shows a working state and cannot be asked twice at once', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const load = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<ScoreExplanationPanel load={load} resetKey="n0" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /why this score/i }));
    expect(screen.getByRole('button', { name: /explaining/i })).toBeDisabled();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => finish(answer()));
    expect(await screen.findByText(/no limit is stated/i)).toBeInTheDocument();
  });

  it('says so and offers another try when the explanation fails', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(answer());
    render(<ScoreExplanationPanel load={load} resetKey="n0" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /why this score/i }));
    expect(await screen.findByText(/could not explain this score/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/no limit is stated/i)).toBeInTheDocument();
  });

  it('forgets an explanation when the item or its score changes (it would describe something else)', async () => {
    const load = vi.fn().mockResolvedValue(answer());
    const { rerender } = render(<ScoreExplanationPanel load={load} resetKey="n0:60" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    await screen.findByText(/no limit is stated/i);
    rerender(<ScoreExplanationPanel load={load} resetKey="n0:75" />);
    await waitFor(() => expect(screen.queryByText(/no limit is stated/i)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /why this score/i })).toBeInTheDocument();
  });

  it('a late answer for an earlier item is not shown for the new one', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const load = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { rerender } = render(<ScoreExplanationPanel load={load} resetKey="n0" />);
    await userEvent.setup().click(screen.getByRole('button', { name: /why this score/i }));
    rerender(<ScoreExplanationPanel load={load} resetKey="n1" />);
    await act(async () => finish(answer()));
    expect(screen.queryByText(/no limit is stated/i)).not.toBeInTheDocument();
  });
});
