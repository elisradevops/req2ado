import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DuplicateMatchCard } from './DuplicateMatchCard';

const skipped = { action: 'dedup_skip' as const, existingAdoId: 123, similarity: 0.926 };
const overridden = { action: 'create' as const, existingAdoId: null, similarity: null, duplicateOf: { existingAdoId: 123, similarity: 0.926 }, duplicateOverride: { linkTree: true, relateToExisting: false } };

function renderCard(entry: Parameters<typeof DuplicateMatchCard>[0]['entry'], props: Partial<Parameters<typeof DuplicateMatchCard>[0]> = {}) {
  const handlers = { onOverride: vi.fn().mockResolvedValue(undefined), onUndo: vi.fn().mockResolvedValue(undefined) };
  render(<DuplicateMatchCard entry={entry} orgUrl="https://dev.azure.com/org" project="Proj" canDecide {...handlers} {...props} />);
  return handlers;
}

describe('DuplicateMatchCard', () => {
  describe('an item skipped because it already exists', () => {
    it('says it already exists, links to the existing item, and says how alike they are', () => {
      renderCard(skipped);

      expect(screen.getByText(/already exists in azure devops/i)).toBeInTheDocument();
      const link = screen.getByRole('link', { name: /work item 123/i });
      expect(link).toHaveAttribute('href', 'https://dev.azure.com/org/Proj/_workitems/edit/123');
      expect(screen.getByText(/93% similar/i)).toBeInTheDocument();
    });

    it('says what will happen: not created, and the existing item is not changed', () => {
      renderCard(skipped);

      expect(screen.getByText(/will not be created/i)).toBeInTheDocument();
      expect(screen.getByText(/existing item is not changed/i)).toBeInTheDocument();
    });

    it('does not claim a similarity it does not have', () => {
      renderCard({ ...skipped, similarity: null });

      expect(screen.queryByText(/% similar/i)).toBeNull();
    });

    it('offers to create it as a new item, only while the review can still change', () => {
      renderCard(skipped, { canDecide: false });

      expect(screen.queryByRole('button', { name: /create as new item/i })).toBeNull();
    });
  });

  describe('creating it anyway', () => {
    async function open() {
      const handlers = renderCard(skipped);
      await userEvent.click(screen.getByRole('button', { name: /create as new item/i }));
      return { handlers, dialog: await screen.findByRole('dialog', { name: /create as a new item/i }) };
    }

    it('explains what it does before doing anything', async () => {
      const { handlers, dialog } = await open();

      expect(within(dialog).getByText(/new work item is created with this content/i)).toBeInTheDocument();
      expect(within(dialog).getByText(/links and attachments stay as they are/i)).toBeInTheDocument();
      expect(handlers.onOverride).not.toHaveBeenCalled();
    });

    it('offers the two optional links: into this job\'s tree (on by default) and Related to the existing item (off)', async () => {
      const { dialog } = await open();

      expect(within(dialog).getByRole('checkbox', { name: /link it into this job's tree/i })).toBeChecked();
      expect(within(dialog).getByRole('checkbox', { name: /also link it to work item 123 as related/i })).not.toBeChecked();
    });

    it('sends the defaults when confirmed as it is', async () => {
      const { handlers, dialog } = await open();

      await userEvent.click(within(dialog).getByRole('button', { name: /^create as new item$/i }));

      expect(handlers.onOverride).toHaveBeenCalledWith({ linkTree: true, relateToExisting: false });
    });

    it('sends the choices the reviewer made', async () => {
      const { handlers, dialog } = await open();
      await userEvent.click(within(dialog).getByRole('checkbox', { name: /link it into this job's tree/i }));
      await userEvent.click(within(dialog).getByRole('checkbox', { name: /also link it to work item 123 as related/i }));

      await userEvent.click(within(dialog).getByRole('button', { name: /^create as new item$/i }));

      expect(handlers.onOverride).toHaveBeenCalledWith({ linkTree: false, relateToExisting: true });
    });

    it('does nothing when cancelled', async () => {
      const { handlers, dialog } = await open();

      await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

      expect(handlers.onOverride).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('stays open and says so when the server refuses, so the reviewer can try again', async () => {
      const handlers = renderCard(skipped);
      handlers.onOverride.mockRejectedValue(new Error('nope'));
      await userEvent.click(screen.getByRole('button', { name: /create as new item/i }));
      const dialog = await screen.findByRole('dialog');

      await userEvent.click(within(dialog).getByRole('button', { name: /^create as new item$/i }));

      expect(await within(dialog).findByText(/could not create it as a new item/i)).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('an item created although it matched', () => {
    it('says it will be created as a new item, what it matched, and that the match is not changed', () => {
      renderCard(overridden);

      expect(screen.getByText(/will be created as a new item/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /work item 123/i })).toBeInTheDocument();
      expect(screen.getByText(/93% similar/i)).toBeInTheDocument();
      expect(screen.getByText(/existing item is not changed/i)).toBeInTheDocument();
    });

    it('says which links were chosen, in words', () => {
      renderCard({ ...overridden, duplicateOverride: { linkTree: false, relateToExisting: true } });

      expect(screen.getByText(/not linked into this job's tree/i)).toBeInTheDocument();
      expect(screen.getByText(/related to work item 123/i)).toBeInTheDocument();
    });

    it('can be undone, which puts the skip back', async () => {
      const { onUndo } = renderCard(overridden);

      await userEvent.click(screen.getByRole('button', { name: /undo/i }));

      expect(onUndo).toHaveBeenCalled();
    });

    it('cannot be undone once the review is closed', () => {
      renderCard(overridden, { canDecide: false });

      expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    });
  });

  it('shows nothing for an item that has no match', () => {
    const { container } = render(<DuplicateMatchCard entry={{ action: 'create', existingAdoId: null, similarity: null }} orgUrl={null} canDecide onOverride={vi.fn()} onUndo={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });
});
