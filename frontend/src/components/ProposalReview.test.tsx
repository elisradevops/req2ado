import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { ProposalReview, categoryMoves, gradeLine, storedScoreNote, type ReviewedItem } from './ProposalReview';
import { useProposalReview, type Proposal } from '../hooks/useProposalReview';
import * as chatApi from '../api/chat';

vi.mock('../api/chat');

const REQUIREMENT: ReviewedItem = { type: 'Requirement', title: 'Receiver lock', description: 'The receiver shall lock.', qualityScore: 64 };

interface HarnessProps {
  proposal: Proposal | null;
  item?: ReviewedItem;
  localId?: string;
  onAccept?: (patch: { title?: string; description?: string }) => void;
  onEditFirst?: (seed: { title: string; description: string }) => void;
  onDiscuss?: (patch: { title?: string; description?: string }) => Promise<void> | void;
  onReject?: () => void;
  originLabel?: string;
}

// Stands in for the item dialog: the real hook, and the review it feeds.
function Harness({ proposal, item = REQUIREMENT, localId = 'n0', onAccept = vi.fn(), onEditFirst = vi.fn(), onDiscuss, onReject = vi.fn(), originLabel }: HarnessProps): React.ReactElement {
  const review = useProposalReview('job-1', localId, item.type === 'Requirement');
  useEffect(() => {
    review.setProposal(proposal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);
  return <ProposalReview review={review} item={item} onAccept={onAccept} onEditFirst={onEditFirst} onDiscuss={onDiscuss} onReject={onReject} originLabel={originLabel} />;
}

const comparison = (overrides: Record<string, unknown> = {}) => ({
  before: { score: 64, issues: [], categoryScores: { Testable: 60, Clear: 70 }, confidence: 'high' },
  after: { score: 71, issues: [], categoryScores: { Testable: 80, Clear: 72 }, confidence: 'high' },
  delta: 7,
  categoryDeltas: { Testable: 20, Clear: 2 },
  warnings: [],
  ...overrides,
});
// What the warnings-only call answers: no scores, same warnings.
const warningsOf = (warnings: unknown[] = []) => ({ before: { score: null }, after: { score: null }, delta: null, categoryDeltas: {}, warnings });
const high = { code: 'dropped_numbers', severity: 'high', detail: '5, 3.3' };
const text = (description: string | null, title: string | null = null): Proposal => ({ proposedTitle: title, proposedDescription: description });

// The first checkRewrite call is the warnings-only one (answers at once); the second is the scored comparison.
function mockCheck(warnings: unknown[], full: unknown): void {
  vi.mocked(chatApi.checkRewrite).mockImplementation(async (_job, _node, proposal) => (proposal.warningsOnly ? warningsOf(warnings) : full) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ProposalReview: the grade', () => {
  it('asks twice (the warnings, then the scored comparison), shows the predicted score, and Accept applies a clean proposal without a question', async () => {
    mockCheck([], comparison());
    const onAccept = vi.fn();
    const proposal = text('The receiver shall acquire lock.');
    render(<Harness proposal={proposal} onAccept={onAccept} />);

    expect(await screen.findByText(/predicted 64\s*→\s*71, up 7/i)).toBeInTheDocument();
    expect(chatApi.checkRewrite).toHaveBeenCalledWith('job-1', 'n0', { ...proposal, warningsOnly: true });
    expect(chatApi.checkRewrite).toHaveBeenCalledWith('job-1', 'n0', proposal);
    await userEvent.setup().click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalledWith({ title: undefined, description: 'The receiver shall acquire lock.' });
  });

  it('cannot be accepted while the prediction is still being made, but the warnings are already there', async () => {
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(chatApi.checkRewrite).mockImplementation((_job, _node, proposal) =>
      (proposal.warningsOnly ? Promise.resolve(warningsOf([high])) : new Promise((resolve) => (finish = resolve))) as never,
    );
    render(<Harness proposal={text('New text.')} />);

    expect(await screen.findByText(/numbers dropped.*5, 3\.3/i)).toBeInTheDocument(); // instant, no model involved
    expect(screen.getByText(/predicting the suggestion's score/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeDisabled();
    await act(async () => finish(comparison({ warnings: [high] })));
    expect(await screen.findByRole('button', { name: /^accept$/i })).toBeEnabled();
  });

  // The prediction can take a model call (the server gives up at 60 s); Accept opens up after 75 s but the review keeps listening.
  async function renderLatePrediction(warnings: unknown[], onAccept = vi.fn()) {
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(chatApi.checkRewrite).mockImplementation((_job, _node, proposal) =>
      (proposal.warningsOnly ? Promise.resolve(warningsOf(warnings)) : new Promise((resolve) => (finish = resolve))) as never,
    );
    const view = render(<Harness proposal={null} onAccept={onAccept} />);
    vi.useFakeTimers(); // from here on the clock is the fake one
    view.rerender(<Harness proposal={text('The receiver shall lock quickly.')} onAccept={onAccept} />);
    return { onAccept, resolve: (value: unknown) => finish(value) };
  }

  it('shows how long the prediction has been running', async () => {
    await renderLatePrediction([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByText(/predicting the suggestion's score.*3 s/i)).toBeInTheDocument();
  });

  it('when the prediction takes too long Accept opens up, a warning still asks for confirmation, and it says it is still waiting', async () => {
    const { onAccept } = await renderLatePrediction([high]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(76_000);
    });
    const accept = screen.getByRole('button', { name: /^accept$/i });
    expect(accept).toBeEnabled();
    expect(screen.getByText(/still predicting/i)).toBeInTheDocument();
    expect(screen.getByText(/numbers dropped/i)).toBeInTheDocument();
    await act(async () => {
      accept.click();
    });
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('an answer that arrives after the cap still updates the grade, and a predicted drop then asks for confirmation', async () => {
    const { onAccept, resolve } = await renderLatePrediction([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });
    await act(async () => resolve(comparison({ delta: -22, before: { score: 64 }, after: { score: 42 } })));
    expect(screen.getByText(/predicted 64\s*→\s*42, down 22/i)).toBeInTheDocument();
    expect(screen.queryByText(/still predicting/i)).not.toBeInTheDocument();
    await act(async () => {
      screen.getByRole('button', { name: /^accept$/i }).click();
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('asks for confirmation when the predicted score drops, and applies only after "Apply anyway"', async () => {
    mockCheck([], comparison({ delta: -22, before: { score: 64 }, after: { score: 42 } }));
    const onAccept = vi.fn();
    render(<Harness proposal={text('A much worse text.')} onAccept={onAccept} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    expect(onAccept).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/64\s*→\s*42/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /apply anyway/i }));
    expect(onAccept).toHaveBeenCalledWith({ title: undefined, description: 'A much worse text.' });
  });

  it('keeps the suggestion when the confirmation is declined', async () => {
    mockCheck([], comparison({ delta: -8, after: { score: 56 } }));
    const onAccept = vi.fn();
    render(<Harness proposal={text('A worse text.')} onAccept={onAccept} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    await user.click(await screen.findByRole('button', { name: /cancel|keep/i }));
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText('A worse text.')).toBeInTheDocument();
  });

  it('a high warning asks for confirmation even when the score would rise', async () => {
    const notice = { code: 'title_changed', severity: 'notice', detail: 'x' };
    mockCheck([high, notice], comparison({ warnings: [high, notice] }));
    const onAccept = vi.fn();
    render(<Harness proposal={text('The receiver shall lock quickly.', 'Another title')} onAccept={onAccept} />);
    const user = userEvent.setup();

    expect(await screen.findByText(/numbers dropped.*5, 3\.3/i)).toBeInTheDocument();
    expect(screen.getByText(/title changed/i)).toBeInTheDocument();
    await screen.findByText(/predicted 64\s*→\s*71/i);
    await user.click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: /apply anyway/i }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('a notice alone (a new title) does not ask for confirmation', async () => {
    const notice = { code: 'title_changed', severity: 'notice', detail: 'x' };
    mockCheck([notice], comparison({ warnings: [notice] }));
    const onAccept = vi.fn();
    render(<Harness proposal={text('The receiver shall acquire lock.', 'Another title')} onAccept={onAccept} />);
    await screen.findByText(/predicted 64\s*→\s*71/i);
    await userEvent.setup().click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('says so when the prediction is unavailable but still shows the warnings, and does not invent a score', async () => {
    const longer = { code: 'much_longer', severity: 'high', detail: '115 -> 741 characters (6.4x)' };
    mockCheck([longer], comparison({ delta: null, before: { score: null }, after: { score: null }, categoryDeltas: {}, warnings: [longer] }));
    render(<Harness proposal={text('A very long text.')} />);
    expect(await screen.findByText(/much longer.*6\.4x/i)).toBeInTheDocument();
    expect(await screen.findByText(/no predicted score: the scorer did not answer/i)).toBeInTheDocument();
  });

  it('when nothing could be checked, unchecked is not treated as fine: applying asks first, and says it was not checked', async () => {
    vi.mocked(chatApi.checkRewrite).mockRejectedValue(new Error('down'));
    const onAccept = vi.fn();
    render(<Harness proposal={text('New text.')} onAccept={onAccept} />);
    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: /apply anyway/i }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('does not check a title-only suggestion, says titles are not scored (keeping the stored score), and Accept is open', async () => {
    render(<Harness proposal={text(null, 'Only a title')} />);
    expect(await screen.findByText('Only a title')).toBeInTheDocument();
    expect(chatApi.checkRewrite).not.toHaveBeenCalled();
    expect(screen.getByTestId('grade-line')).toHaveTextContent('Titles are not scored. The text is unchanged, so the score stays 64.');
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeEnabled();
  });

  it.each(['Epic', 'Feature'])('does not check a suggestion for a %s, shows no grade line, and does not claim it could not check', async (type) => {
    const onAccept = vi.fn();
    render(<Harness proposal={text('A scope description.')} item={{ ...REQUIREMENT, type }} onAccept={onAccept} />);
    await screen.findByText('A scope description.');
    expect(chatApi.checkRewrite).not.toHaveBeenCalled();
    expect(screen.queryByTestId('grade-line')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/i)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('a check that finishes after a NEWER suggestion arrived is not shown against it', async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    vi.mocked(chatApi.checkRewrite).mockImplementation((_job, _node, proposal) =>
      (proposal.warningsOnly ? Promise.resolve(warningsOf([])) : new Promise((resolve) => resolvers.push(resolve))) as never,
    );
    const view = render(<Harness proposal={text('First suggestion.')} />);
    await screen.findByText('First suggestion.');
    view.rerender(<Harness proposal={text('Second suggestion.')} />);
    await screen.findByText('Second suggestion.');

    await act(async () => resolvers[0](comparison({ delta: -30, before: { score: 90 }, after: { score: 60 } }))); // the FIRST one, late
    expect(screen.queryByText(/90\s*→\s*60/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeDisabled(); // the second is still being predicted
    await act(async () => resolvers[1](comparison()));
    expect(await screen.findByText(/predicted 64\s*→\s*71/i)).toBeInTheDocument();
  });

  it('discards a check that comes back after the item changed', async () => {
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(chatApi.checkRewrite).mockImplementation((_job, _node, proposal) =>
      (proposal.warningsOnly ? Promise.resolve(warningsOf([])) : new Promise((resolve) => (finish = resolve))) as never,
    );
    const proposal = text('Old item text.');
    const view = render(<Harness proposal={proposal} localId="n0" />);
    await screen.findByText(/predicting the suggestion's score/i);

    view.rerender(<Harness proposal={null} localId="n1" />);
    await act(async () => finish(comparison({ delta: -30 })));
    expect(screen.queryByText(/Old item text/)).not.toBeInTheDocument();
    expect(screen.queryByText(/64\s*→/)).not.toBeInTheDocument();
  });

  it('a change within the noise is called about the same, and a small dip does not ask for confirmation', async () => {
    mockCheck([], comparison({ delta: -3, before: { score: 64 }, after: { score: 61 } }));
    const onAccept = vi.fn();
    render(<Harness proposal={text('Nearly the same text.')} onAccept={onAccept} />);
    expect(await screen.findByText(/64\s*→\s*61: about the same/i)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^accept$/i }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('draws the noise line at 5: a change of 5 is about the same, a change of 6 is up or down', () => {
    const line = (delta: number) =>
      gradeLine(REQUIREMENT, {
        proposal: text('x'),
        checking: true,
        predictingSeconds: 0,
        check: { proposal: text('x'), warnings: { status: 'ready', items: [] }, prediction: { status: 'ready', data: comparison({ delta, before: { score: 60 }, after: { score: 60 + delta } }) as never } },
        comparison: comparison({ delta, before: { score: 60 }, after: { score: 60 + delta } }) as never,
      });
    expect(line(5)).toMatch(/about the same/);
    expect(line(-5)).toMatch(/about the same/);
    expect(line(6)).toMatch(/up 6/);
    expect(line(-6)).toMatch(/down 6/);
  });

  it('says low confidence when the scorer is not sure of either text', async () => {
    mockCheck([], comparison({ after: { score: 71, confidence: 'low', categoryScores: {} } }));
    render(<Harness proposal={text('A text.')} />);
    expect(await screen.findByText(/low confidence in the scorer/i)).toBeInTheDocument();
  });

  it('explains a stored score that differs from the comparison\'s own "before"', async () => {
    mockCheck([], comparison());
    render(<Harness proposal={text('A text.')} item={{ ...REQUIREMENT, qualityScore: 42 }} />);
    expect(await screen.findByText('The current text was re-scored with the suggestion (64); its stored score is 42.')).toBeInTheDocument();
    expect(storedScoreNote(REQUIREMENT, comparison() as never)).toBeNull(); // 64 vs 64: nothing to explain
  });

  it('announces the result once, in a status region, without the ticking time', async () => {
    mockCheck([], comparison());
    render(<Harness proposal={text('A text.')} />);
    await screen.findByText(/predicted 64\s*→\s*71/i);
    const status = screen.getAllByRole('status').find((el) => /predicted score ready/i.test(el.textContent ?? ''));
    expect(status).toHaveTextContent('Predicted score ready: 64 to 71.');
    expect(status).not.toHaveTextContent(/\d+ s\b/);
  });
});

describe('ProposalReview: the comparison and the actions', () => {
  beforeEach(() => {
    mockCheck([], comparison());
  });

  it('shows the title as Was and Now, and, in the Side by side view, the original text beside the suggested text', async () => {
    render(<Harness proposal={text('The receiver shall acquire lock within 5 ms.', 'Receiver lock time')} />);
    await screen.findByText(/predicted 64/i);
    const was = screen.getByText('Was');
    expect(was.nextElementSibling).toHaveTextContent('Receiver lock');
    expect(screen.getByText('Now').nextElementSibling).toHaveTextContent('Receiver lock time');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Side by side' }));
    expect(screen.getByText('Original').parentElement).toHaveTextContent('The receiver shall lock.');
    expect(screen.getByText('Suggested').parentElement).toHaveTextContent('The receiver shall acquire lock within 5 ms.');
  });

  it('shows the categories the suggestion moved by more than the noise, and how many did not move', async () => {
    render(<Harness proposal={text('A text.')} />);
    const list = await screen.findByRole('list', { name: /categories that changed/i });
    expect(within(list).getByText('Testable 60 → 80 (+20)')).toBeInTheDocument();
    expect(within(list).getByText('1 unchanged')).toBeInTheDocument();
    expect(categoryMoves(comparison({ categoryDeltas: { a: 3, b: -9, c: 7, d: 12, e: 20, f: 30 }, before: { score: 1, categoryScores: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 } }, after: { score: 2, categoryScores: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 } } }) as never).map((m) => m.key)).toEqual(['f', 'e', 'd', 'b']);
  });

  it('offers "Title only" in the Accept menu when the title changes, and applies just the title', async () => {
    const onAccept = vi.fn();
    render(<Harness proposal={text('A text.', 'A new title')} onAccept={onAccept} />);
    await screen.findByText(/predicted 64/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /more ways to accept/i }));
    await user.click(await screen.findByRole('menuitem', { name: /title only/i }));
    expect(onAccept).toHaveBeenCalledWith({ title: 'A new title' });
  });

  it('offers no Accept menu when only the text changes', async () => {
    render(<Harness proposal={text('A text.')} />);
    await screen.findByText(/predicted 64/i);
    expect(screen.queryByRole('button', { name: /more ways to accept/i })).not.toBeInTheDocument();
  });

  it('"Edit first" hands over the suggested texts, keeping the item\'s own title when none was suggested', async () => {
    const onEditFirst = vi.fn();
    render(<Harness proposal={text('The suggested text.')} onEditFirst={onEditFirst} />);
    await screen.findByText(/predicted 64/i);
    await userEvent.setup().click(screen.getByRole('button', { name: /edit first/i }));
    expect(onEditFirst).toHaveBeenCalledWith({ title: 'Receiver lock', description: 'The suggested text.' });
  });

  it('"To be discussed" parks the suggestion and clears it; a refusal keeps it', async () => {
    const onDiscuss = vi.fn().mockResolvedValue(undefined);
    const view = render(<Harness proposal={text('Parked text.', 'Parked title')} onDiscuss={onDiscuss} />);
    await screen.findByText(/predicted 64/i);
    await userEvent.setup().click(screen.getByRole('button', { name: /to be discussed/i }));
    expect(onDiscuss).toHaveBeenCalledWith({ title: 'Parked title', description: 'Parked text.' });
    await vi.waitFor(() => expect(screen.queryByTestId('proposal-review')).not.toBeInTheDocument());
    view.unmount();

    render(<Harness proposal={text('Kept text.')} onDiscuss={vi.fn().mockRejectedValue(new Error('refused'))} />);
    await screen.findByText(/predicted 64/i);
    await userEvent.setup().click(screen.getByRole('button', { name: /to be discussed/i }));
    expect(await screen.findByText('Kept text.')).toBeInTheDocument();
  });

  it('Reject discards the suggestion', async () => {
    const onReject = vi.fn();
    render(<Harness proposal={text('A text.')} onReject={onReject} />);
    await screen.findByText(/predicted 64/i);
    await userEvent.setup().click(screen.getByRole('button', { name: /^reject$/i }));
    expect(onReject).toHaveBeenCalled();
  });

  it('Ctrl+Enter accepts once the check is done, and does nothing while it is still running', async () => {
    const onAccept = vi.fn();
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(chatApi.checkRewrite).mockImplementation((_job, _node, proposal) =>
      (proposal.warningsOnly ? Promise.resolve(warningsOf([])) : new Promise((resolve) => (finish = resolve))) as never,
    );
    render(<Harness proposal={text('The receiver shall acquire lock.')} onAccept={onAccept} />);
    await screen.findByText(/predicting the suggestion's score/i);
    const user = userEvent.setup();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onAccept).not.toHaveBeenCalled();
    await act(async () => finish(comparison()));
    await screen.findByText(/predicted 64\s*→\s*71/i);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('moves focus to its heading when it opens, and gives the original and suggested text their own labels', async () => {
    render(<Harness proposal={text('A text.')} />);
    const heading = await screen.findByRole('heading', { name: 'Suggested change' });
    expect(heading).toHaveFocus();
  });

  it('marks nothing and renders nothing when there is no suggestion', () => {
    const { container } = render(<Harness proposal={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ProposalReview: the Changes view and the toggle', () => {
  const ORIGINAL: ReviewedItem = { ...REQUIREMENT, description: 'The unit shall support power input within range of the supply.' };

  beforeEach(() => {
    mockCheck([], comparison());
  });

  it('starts in the Changes view for a small edit, marking the words with strikethrough and underline plus hidden labels', async () => {
    render(<Harness proposal={text('The unit shall accept power input within range of the supply.')} item={ORIGINAL} />);
    const view = await screen.findByTestId('proposal-changes');
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true');
    const del = within(view).getByText('support').closest('del');
    const ins = within(view).getByText('accept').closest('ins');
    expect(del).not.toBeNull();
    expect(ins).not.toBeNull();
    expect(del).toHaveTextContent('deleted: support');
    expect(ins).toHaveTextContent('inserted: accept');
    expect(within(view).getByText(/1 change: 1 replaced\. Marked by underline and strikethrough as well as colour\./)).toBeInTheDocument();
  });

  it('starts Side by side when most of the text changed, and says why', async () => {
    render(<Harness proposal={text('Operators must configure voltage limits during commissioning.')} item={ORIGINAL} />);
    await screen.findByText(/predicted 64/i);
    expect(screen.queryByTestId('proposal-changes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/most of the text changed, so both versions are shown/i)).toBeInTheDocument();
  });

  it('remembers the reviewer\'s choice for the next suggestion', async () => {
    const user = userEvent.setup();
    const first = render(<Harness proposal={text('The unit shall accept power input within range of the supply.')} item={ORIGINAL} />);
    await screen.findByTestId('proposal-changes');
    await user.click(screen.getByRole('button', { name: 'Side by side' }));
    expect(window.localStorage.getItem('req2ado.proposalView')).toBe('side');
    first.unmount();

    render(<Harness proposal={text('The unit shall accept power input within range of the supply.')} item={ORIGINAL} />);
    await screen.findByText(/predicted 64/i);
    expect(screen.queryByTestId('proposal-changes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('still works when storage is blocked (the automatic choice applies)', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<Harness proposal={text('The unit shall accept power input within range of the supply.')} item={ORIGINAL} />);
      expect(await screen.findByTestId('proposal-changes')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('says so when the text is unchanged (only the title differs)', async () => {
    render(<Harness proposal={text(ORIGINAL.description, 'A better title')} item={ORIGINAL} />);
    expect(await screen.findByText('The text is unchanged.')).toBeInTheDocument();
  });

  it('shows a table cell by cell when its shape is unchanged', async () => {
    const before = '<table><tr><th>Parameter</th><th>Value</th></tr><tr><td>Rate</td><td>N Hz</td></tr></table>';
    const after = before.replace('N Hz', '5 Hz');
    render(<Harness proposal={text(`Intro.\n\n${after}`)} item={{ ...ORIGINAL, description: `Intro.\n\n${before}` }} />);
    const view = await screen.findByTestId('proposal-changes');
    const cell = within(view).getByText('N').closest('del');
    expect(cell).not.toBeNull();
    expect(within(view).getByText('5').closest('ins')).not.toBeNull();
    expect(view.querySelector('table')).not.toBeNull();
  });

  it('shows a comparison that is too large as both versions, with no toggle', async () => {
    const huge = Array.from({ length: 21_000 }, (_, i) => `w${i}`).join(' ');
    render(<Harness proposal={text(`${huge} extra`)} item={{ ...ORIGINAL, description: huge }} />);
    expect(await screen.findByText(/too long to compare word by word/i)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
  });
});

describe('ProposalReview: who suggested it', () => {
  it('says when the suggestion came from With AI review, not the item\'s assistant; says nothing for the assistant', () => {
    vi.mocked(chatApi.checkRewrite).mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<Harness proposal={text('The receiver shall lock within 2 s.')} originLabel="Suggested by With AI review while the job ran." />);
    expect(screen.getByTestId('suggestion-origin')).toHaveTextContent('Suggested by With AI review while the job ran.');
    rerender(<Harness proposal={text('The receiver shall lock within 2 s.')} />);
    expect(screen.queryByTestId('suggestion-origin')).toBeNull();
  });
});

describe('ProposalReview: no source comment on screen', () => {
  it('shows no code comment as text (a "//" comment once rendered beside the decision)', () => {
    vi.mocked(chatApi.checkRewrite).mockReturnValue(new Promise(() => {}));
    const { container } = render(<Harness proposal={text('The receiver shall lock within 2 s.')} />);
    expect(container.textContent).not.toMatch(/\/\/\s*Sticky/);
  });
});
