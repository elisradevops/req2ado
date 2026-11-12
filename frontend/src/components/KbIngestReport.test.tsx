import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbIngestReport } from './KbIngestReport';
import type { KbIngestBatch, KbIngestItem, KbIngestItemState, KbProfile, KbProfileDocument } from '../api/kb';
import type { KbProfileRead } from '../hooks/useKbProfile';

function item(n: number, state: KbIngestItemState, overrides: Partial<KbIngestItem> = {}): KbIngestItem {
  return {
    id: `i${n}`, ordinal: n, itemId: `item-${n}`, name: `file${n}.pdf`, relativePath: `Sub/file${n}.pdf`, sizeBytes: 100, retrievalMode: 'retrieve', state, attempts: 0, errorKind: null,
    reason: null, chunksStored: null, chunksInStore: null, ingestedDocumentId: null, startedAt: null, finishedAt: null, ...overrides,
  };
}

function batch(items: KbIngestItem[]): KbIngestBatch {
  const count = (s: KbIngestItemState) => items.filter((i) => i.state === s).length;
  return {
    id: 'b1', status: 'completed', pauseReason: null, cancelRequested: false, driveId: 'd', folderItemId: null, folderPath: '', docType: null, version: 1,
    createdAt: '2026-11-12T09:00:00Z', startedAt: null, finishedAt: '2026-11-12T09:05:00Z',
    counts: { total: items.length, queued: 0, running: 0, added: count('added'), unchanged: count('unchanged'), failed: count('failed'), skipped: count('skipped'), cancelled: count('cancelled') }, items,
  };
}

const doc = (file: string, status: string, overrides: Partial<KbProfileDocument> = {}): KbProfileDocument => ({ file, status, reason: null, categories: 0, rules: 0, typeDefinitions: 0, glossary: 0, ...overrides });
const profile = (overrides: Partial<KbProfile> = {}): KbProfile => ({
  state: 'ready', builtAt: '2026-11-12T09:10:00Z', version: 'v1', builtWith: 'model', docsInKb: 3, docsContributing: 2, truncated: false, docs: [], conflicts: [], ...overrides,
});
const read = (status: KbProfileRead['status'], p: KbProfile | null = null): KbProfileRead => ({ status, profile: p, refresh: vi.fn() });

function renderReport(b: KbIngestBatch, rubric: KbProfileRead, props: Partial<React.ComponentProps<typeof KbIngestReport>> = {}) {
  const handlers = { onOpenChange: vi.fn(), onCustomizeRubric: vi.fn() };
  render(<KbIngestReport open batch={b} rubric={rubric} {...handlers} {...props} />);
  return handlers;
}

const row = (name: string) => screen.getByText(name).closest('li')!;

describe('KbIngestReport', () => {
  describe('the files', () => {
    it('says what happened to every file, in words, with how much text was stored', () => {
      renderReport(
        batch([item(1, 'added', { chunksInStore: 12 }), item(2, 'unchanged', { chunksInStore: 7 }), item(3, 'failed', { reason: 'unsupported file type' }), item(4, 'skipped', { reason: 'already queued in another batch' }), item(5, 'cancelled')]),
        read('loading'),
      );

      expect(row('file1.pdf')).toHaveTextContent(/added · 12 chunks/i);
      expect(row('file2.pdf')).toHaveTextContent(/already up to date · 7 chunks/i);
      expect(row('file3.pdf')).toHaveTextContent(/failed.*unsupported file type/i);
      expect(row('file4.pdf')).toHaveTextContent(/skipped.*already queued in another batch/i);
      expect(row('file5.pdf')).toHaveTextContent(/cancelled/i);
    });

    it('warns about a file that stored no text, and says what to try', () => {
      renderReport(batch([item(1, 'added', { chunksInStore: 0 })]), read('loading'));

      expect(row('file1.pdf')).toHaveTextContent(/no text could be stored/i);
      expect(row('file1.pdf')).toHaveTextContent(/scanned|images/i);
    });

    it('shows the folder a file came from, and a Hebrew name bidirectionally safe', () => {
      renderReport(batch([item(1, 'added', { name: 'מדריך.docx', relativePath: 'תיקייה/מדריך.docx', chunksInStore: 3 })]), read('loading'));

      expect(screen.getByText('מדריך.docx').closest('bdi')).toHaveAttribute('dir', 'auto');
      expect(row('מדריך.docx')).toHaveTextContent('תיקייה');
    });
  });

  describe('what the grading rubric learned', () => {
    const b = () => batch([item(1, 'added', { chunksInStore: 5 }), item(2, 'added', { chunksInStore: 6 }), item(3, 'added', { chunksInStore: 7 }), item(4, 'added', { chunksInStore: 8 })]);

    it('says it is being updated while it waits, in one status region', () => {
      renderReport(b(), read('waiting'));

      expect(screen.getByRole('status')).toHaveTextContent(/updating the grading rubric/i);
    });

    it('says what each file gave the rubric once it is built', () => {
      const p = profile({
        docs: [doc('file1.pdf', 'contributed', { categories: 3, rules: 5 }), doc('file2.pdf', 'not_relevant', { reason: 'a meeting agenda' }), doc('file3.pdf', 'extracted_nothing'), doc('file4.pdf', 'failed', { reason: 'model timed out' })],
        docsInKb: 4, docsContributing: 1,
      });
      renderReport(b(), read('ready', p));

      expect(row('file1.pdf')).toHaveTextContent(/shaped the rubric.*3 categories.*5 rules/i);
      expect(row('file2.pdf')).toHaveTextContent(/not used by the rubric.*a meeting agenda/i);
      expect(row('file3.pdf')).toHaveTextContent(/nothing could be extracted/i);
      expect(row('file4.pdf')).toHaveTextContent(/could not be analysed.*model timed out/i);
      expect(screen.getByText(/the rubric draws on 1 of 4 documents/i)).toBeInTheDocument();
    });

    it('says a file is not in this build yet when the rubric does not list it', () => {
      renderReport(batch([item(1, 'added', { chunksInStore: 5 })]), read('ready', profile({ docs: [] })));

      expect(row('file1.pdf')).toHaveTextContent(/not in the rubric yet/i);
    });

    it('does not claim anything for a file that was not added', () => {
      renderReport(batch([item(1, 'failed', { reason: 'boom' })]), read('ready', profile({ docs: [doc('file1.pdf', 'contributed')] })));

      expect(row('file1.pdf')).not.toHaveTextContent(/shaped the rubric/i);
    });

    it('flags a file name that appears in more than one folder, since the rubric lists names', () => {
      const items = [item(1, 'added', { name: 'same.pdf', relativePath: 'A/same.pdf', chunksInStore: 1 }), item(2, 'added', { name: 'same.pdf', relativePath: 'B/same.pdf', chunksInStore: 1 })];
      renderReport(batch(items), read('ready', profile({ docs: [doc('same.pdf', 'contributed')] })));

      expect(screen.getAllByText(/same name as another file/i)).toHaveLength(2);
    });

    it('mentions conflicts the rubric found between documents, and a truncated read', () => {
      renderReport(b(), read('ready', profile({ conflicts: [{ kind: 'type_definition', key: 'Requirement', variantCount: 2 }], truncated: true })));

      expect(screen.getByText(/1 disagreement between documents/i)).toBeInTheDocument();
      expect(screen.getByText(/not every document fit in one read/i)).toBeInTheDocument();
    });

    it.each([
      ['timeout', /still not updated|check back later/i],
      ['no_model', /no model connection/i],
      ['none', /no rubric yet/i],
      ['error', /could not read the rubric/i],
    ] as const)('says so plainly when it is %s', (status, text) => {
      renderReport(b(), read(status));

      expect(screen.getByText(text)).toBeInTheDocument();
    });

    it('offers to customize the rubric once it is built, and not before', async () => {
      const { onCustomizeRubric } = renderReport(b(), read('ready', profile()));

      await userEvent.click(screen.getByRole('button', { name: /customize the rubric/i }));

      expect(onCustomizeRubric).toHaveBeenCalled();
    });

    it('has no customize button while it is still updating', () => {
      renderReport(b(), read('waiting'));

      expect(screen.queryByRole('button', { name: /customize the rubric/i })).toBeNull();
    });
  });

  it('is a dialog that can be closed', async () => {
    const { onOpenChange } = renderReport(batch([item(1, 'added', { chunksInStore: 1 })]), read('loading'));

    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^close$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('lets a long unbroken file name wrap instead of cutting off the end that tells two files apart', () => {
    const name = 'Requirements_Engineering_and_ADO_Work_Item_Standard_Version_2_Final_Reviewed_Customer_Copy.pdf';
    renderReport(batch([item(1, 'added', { name, relativePath: name, chunksInStore: 1 })]), read('loading'));

    const text = screen.getByText(name).parentElement as HTMLElement;
    expect(text.className).toContain('[overflow-wrap:anywhere]');
    expect(text.className).not.toContain('truncate');
  });
});
