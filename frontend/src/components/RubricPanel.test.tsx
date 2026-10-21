import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RubricPanel } from './RubricPanel';
import { ToastProvider } from './ToastProvider';
import * as kbApi from '../api/kb';

vi.mock('../api/kb');

const category = (overrides: Record<string, unknown> = {}) => ({
  name: 'Testable', passCondition: 'Can be verified', guidance: null, pinned: false, origin: 'kb', sources: ['A.pptx'], mergedFrom: ['Testable'], ...overrides,
});
const rubric = (overrides: Record<string, unknown> = {}) => ({
  version: 'v1', source: 'kb', builtAt: '2026-10-21T10:00:00+00:00',
  categories: [category(), category({ name: 'Unambiguity', passCondition: 'One reading only', mergedFrom: ['Unambiguity', 'Clear and unambiguous'] }), category({ name: 'Essential', passCondition: 'Needed', pinned: true })],
  removed: [], ...overrides,
});

function renderPanel() {
  return render(
    <ToastProvider>
      <RubricPanel />
    </ToastProvider>,
  );
}

describe('RubricPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kbApi.getRubric).mockResolvedValue(rubric() as never);
    vi.mocked(kbApi.putRubric).mockImplementation(async (input) => rubric({ categories: input.pinned.map((p) => category({ name: p.name, passCondition: p.passCondition, pinned: true })) }) as never);
  });

  it('shows every category with its pass condition, says where the rubric comes from, and marks what is pinned', async () => {
    renderPanel();
    expect(await screen.findByText(/from your knowledge base/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Pass condition of Testable')).toHaveValue('Can be verified');
    expect(screen.getByLabelText('Pass condition of Unambiguity')).toHaveValue('One reading only');
    expect(screen.getByText(/also written as: Unambiguity, Clear and unambiguous/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Pin Essential')).toBeChecked();
    expect(screen.getByLabelText('Pin Testable')).not.toBeChecked();
  });

  it('says it is the built-in rubric when there is no knowledge base, and what to do about it', async () => {
    vi.mocked(kbApi.getRubric).mockResolvedValue(rubric({ source: 'default', builtAt: null, categories: [category({ origin: 'default' })] }) as never);
    renderPanel();
    expect(await screen.findByText(/built-in rubric/i)).toBeInTheDocument();
    expect(screen.getByText(/add documents to your knowledge base/i)).toBeInTheDocument();
  });

  it('nothing is saved until something changed', async () => {
    renderPanel();
    await screen.findByText(/from your knowledge base/i);
    expect(screen.getByRole('button', { name: /save rubric/i })).toBeDisabled();
  });

  it('editing a pass condition pins the category, and saving sends every pin and removal', async () => {
    renderPanel();
    const field = await screen.findByLabelText('Pass condition of Testable');
    const user = userEvent.setup();
    await user.clear(field);
    await user.type(field, 'Has a measurable acceptance criterion');
    expect(screen.getByLabelText('Pin Testable')).toBeChecked(); // editing pins it
    await user.click(screen.getByRole('button', { name: /save rubric/i }));
    await waitFor(() => expect(kbApi.putRubric).toHaveBeenCalledTimes(1));
    expect(kbApi.putRubric).toHaveBeenCalledWith({
      pinned: [
        { name: 'Testable', passCondition: 'Has a measurable acceptance criterion' },
        { name: 'Essential', passCondition: 'Needed' },
      ],
      removed: [],
    });
  });

  it('unpinning a category hands it back to the derived rubric (it is not sent as a pin)', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Pin Essential'));
    await user.click(screen.getByRole('button', { name: /save rubric/i }));
    await waitFor(() => expect(kbApi.putRubric).toHaveBeenCalledWith({ pinned: [], removed: [] }));
  });

  it('removing a category lists it as removed (with a way back) and saving sends the removal', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Remove Unambiguity'));
    expect(screen.queryByLabelText('Pass condition of Unambiguity')).not.toBeInTheDocument();
    expect(screen.getByText(/removed:/i)).toHaveTextContent('Unambiguity');
    await user.click(screen.getByRole('button', { name: /save rubric/i }));
    await waitFor(() => expect(kbApi.putRubric).toHaveBeenCalledWith({ pinned: [{ name: 'Essential', passCondition: 'Needed' }], removed: ['Unambiguity'] }));
  });

  it('restoring a removed category brings it back and leaves nothing to save', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('Remove Unambiguity'));
    await user.click(screen.getByRole('button', { name: /restore unambiguity/i }));
    expect(screen.getByLabelText('Pass condition of Unambiguity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save rubric/i })).toBeDisabled();
  });

  it('adds a category of the users own, only when it has a name and a pass condition', async () => {
    renderPanel();
    const user = userEvent.setup();
    await screen.findByText(/from your knowledge base/i);
    const add = screen.getByRole('button', { name: /add category/i });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('New category name'), 'Safety-relevant');
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText('New category pass condition'), 'Names the hazard it mitigates');
    await user.click(add);
    expect(screen.getByLabelText('Pass condition of Safety-relevant')).toHaveValue('Names the hazard it mitigates');
    expect(screen.getByText('Your own')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save rubric/i }));
    await waitFor(() =>
      expect(kbApi.putRubric).toHaveBeenCalledWith({
        pinned: [{ name: 'Essential', passCondition: 'Needed' }, { name: 'Safety-relevant', passCondition: 'Names the hazard it mitigates' }],
        removed: [],
      }),
    );
  });

  it('refuses a new category whose name the rubric already has', async () => {
    renderPanel();
    const user = userEvent.setup();
    await screen.findByText(/from your knowledge base/i);
    await user.type(screen.getByLabelText('New category name'), ' testable ');
    await user.type(screen.getByLabelText('New category pass condition'), 'x');
    expect(screen.getByRole('button', { name: /add category/i })).toBeDisabled();
    expect(screen.getByText(/already in the rubric/i)).toBeInTheDocument();
  });

  it('reset asks first and then sends empty lists', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /reset to the derived rubric/i }));
    expect(kbApi.putRubric).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^reset$/i }));
    await waitFor(() => expect(kbApi.putRubric).toHaveBeenCalledWith({ pinned: [], removed: [] }));
  });

  it('keeps the draft and says why when saving is refused', async () => {
    vi.mocked(kbApi.putRubric).mockRejectedValue(Object.assign(new Error('refused'), { isAxiosError: true, response: { status: 400, data: { message: 'category \'X\' is listed twice' } } }));
    renderPanel();
    const user = userEvent.setup();
    const field = await screen.findByLabelText('Pass condition of Testable');
    await user.type(field, ' more');
    await user.click(screen.getByRole('button', { name: /save rubric/i }));
    expect(await screen.findByText(/could not save the rubric/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Pass condition of Testable')).toHaveValue('Can be verified more');
  });

  it('tells the user when the rubric cannot be loaded, and can try again', async () => {
    vi.mocked(kbApi.getRubric).mockRejectedValueOnce(new Error('down'));
    renderPanel();
    expect(await screen.findByText(/could not load the rubric/i)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText(/from your knowledge base/i)).toBeInTheDocument();
  });
});
