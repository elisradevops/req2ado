import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RulebookView } from '../api/jobs';
import { FileReadingCard, readingLine, type FileReadingRules, type FileReadingStudy } from './FileReadingCard';
import { leftOutNames, pagesPhrase } from '../utils/leftOut';

const LEFT_OUT = {
  parts: [
    { text: 'Revision History', page: 2 },
    { text: 'Table of Contents', page: 2 },
    { text: 'Abbreviations', page: 2 },
  ],
  pages: [1, 2],
  blockIds: ['b1', 'b2'],
  tableIds: [],
  titleBlockId: 'b0',
};
const none = (over: Partial<RulebookView> = {}): RulebookView => ({
  id: null,
  source: 'none',
  hash: '',
  rules: [],
  warnings: [],
  rulebook: {},
  reused: false,
  skipped: null,
  details: null,
  ...over,
});
const ready = (view: RulebookView): FileReadingRules => ({ status: 'ready', view, error: null });
const studyDone: FileReadingStudy = { status: 'skipped', done: 0, total: 0, view: null, error: null };

function renderCard(over: Partial<React.ComponentProps<typeof FileReadingCard>> = {}) {
  return render(
    <FileReadingCard
      overview={{ synopsis: 'Structure: 7 sections.', caveat: null, lines: ['Structure: 7 sections, 2 levels deep.'] }}
      leftOut={LEFT_OUT}
      aiSummary={{ status: 'idle' }}
      onRewriteSummary={vi.fn()}
      rules={ready(none())}
      study={studyDone}
      onRelearn={vi.fn()}
      onSaveEdit={vi.fn().mockResolvedValue(null)}
      {...over}
    />,
  );
}

describe('FileReadingCard', () => {
  it('is one card: what the file is, what is left out with its pages, and how items are built', () => {
    renderCard();
    const card = screen.getByTestId('file-reading-card');
    expect(within(card).getByText('Structure: 7 sections, 2 levels deep.')).toBeInTheDocument();
    const leftOut = screen.getByTestId('file-reading-left-out');
    expect(leftOut).toHaveTextContent('Left out: not requirements (pages 1–2)');
    expect(within(leftOut).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Revision History · p2',
      'Table of Contents · p2',
      'Abbreviations · p2',
    ]);
    expect(within(card).getByText(/does not name its item types in words, so items are built from its own headings and numbering/i)).toBeInTheDocument();
    // The old non-answer is gone.
    expect(within(card).queryByText(/nothing the model could verify/i)).not.toBeInTheDocument();
  });

  it('says a model connection that did not answer is a connection to check, not an unreadable file', () => {
    renderCard({
      rules: ready(none({ warnings: [{ kind: 'prestudy_rejected', raw: 'x', detail: { reason: 'the model could not be asked (0 of 3 answers usable)' } } as never] })),
    });
    expect(screen.getByTestId('file-rules-unreachable')).toHaveTextContent(/your model connection did not answer/i);
    expect(screen.getByRole('button', { name: /read again/i })).toBeInTheDocument();
  });

  it('has one status line and one timer while it reads, and no button of its own', () => {
    renderCard({ rules: { status: 'loading', view: null, error: null, startedAt: new Date().toISOString() } });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent("Reading the file's layout · step 1 of 2");
    expect(screen.getByTestId('file-reading-elapsed')).toHaveTextContent(/so far/);
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
  });

  it('shows nothing about front matter when nothing was left out', () => {
    renderCard({ leftOut: null });
    expect(screen.queryByTestId('file-reading-left-out')).not.toBeInTheDocument();
  });
});

describe('readingLine', () => {
  const rules = (status: FileReadingRules['status']): FileReadingRules => ({ status, view: null, error: null });
  const study = (status: FileReadingStudy['status'], done = 0, total = 0): FileReadingStudy => ({ status, done, total, view: null, error: null });

  it('names the step of two, and the part of the document while it is read', () => {
    expect(readingLine(rules('loading'), study('waiting'))).toBe("Reading the file's layout · step 1 of 2");
    expect(readingLine(rules('ready'), study('reading', 2, 4))).toBe('Reading the document · step 2 of 2 · part 3 of 4');
    expect(readingLine(rules('ready'), study('ready'))).toBeNull();
    expect(readingLine(rules('cancelled'), study('cancelled'))).toBeNull();
  });
});

describe('the left-out wording', () => {
  it('quotes the document’s own headings and counts the rest', () => {
    expect(leftOutNames(LEFT_OUT)).toBe('“Revision History”, “Table of Contents” and “Abbreviations”');
    expect(leftOutNames({ ...LEFT_OUT, parts: [...LEFT_OUT.parts, { text: 'A', page: 3 }, { text: 'B', page: 3 }] })).toBe(
      '“Revision History”, “Table of Contents”, “Abbreviations”, “A” and 1 more',
    );
    expect(pagesPhrase([])).toBe('');
    expect(pagesPhrase([1])).toBe(' (page 1)');
  });
});
