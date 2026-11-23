import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentStudyCard } from './DocumentStudyCard';
import type { DocumentStudy } from '../api/jobs';

const STUDY: DocumentStudy = {
  orientation: { document_type: 'An ICD', purpose: '', system: 'The radar', conventions: 'Numbered shall statements' },
  glossary: [{ term: 'BIT', definition: 'Built-in test' }],
  placeholder_tokens: ['TBD', '??'],
  verification_statements: ['Verified by test'],
  standards_cited: ['MIL-STD-461G'],
  table_roles: [],
  vocabulary: [{ table: 'Sheet', column: 'Method', values: ['Test', 'Analysis', 'Inspection', 'Demonstration', 'A', 'B', 'C', 'D', 'E'], more: 3 }],
  stats: { windows_studied: 10, windows_total: 10, budget_stopped: false, orientation_failed: false, from_cache: false },
  warnings: [],
};

const props = { done: 0, total: 0, study: null, error: null };

describe('DocumentStudyCard', () => {
  it('waits for the file\'s layout first', () => {
    render(<DocumentStudyCard status="waiting" {...props} />);
    expect(screen.getByText("Starts once the file's layout is read.")).toBeInTheDocument();
  });

  it('shows the parts read against the real number of parts, and no number before the server gives one', () => {
    const { rerender } = render(<DocumentStudyCard status="reading" {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting to read the document.');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    rerender(<DocumentStudyCard status="reading" {...props} done={3} total={10} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading part 4 of 10.');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  });

  it('shows what the reading found: the written orientation fields, counts, and the details on request', async () => {
    render(<DocumentStudyCard status="ready" {...props} study={STUDY} />);
    expect(screen.getByText('The radar')).toBeInTheDocument();
    expect(screen.queryByText('Purpose')).not.toBeInTheDocument(); // an empty field is not shown
    expect(screen.getByText('Found 1 verification statement · 1 standard cited · 1 defined term · 2 open-value markers.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /values the tables use/i }));
    expect(screen.getByText(/Test, Analysis, Inspection, Demonstration, A, B, C, D/)).toBeInTheDocument();
    expect(screen.getByText('and 4 more')).toBeInTheDocument(); // one beyond the eight shown, plus three the server left out
  });

  it('says plainly when only part of the document was read', () => {
    render(<DocumentStudyCard status="ready" {...props} study={{ ...STUDY, stats: { ...STUDY.stats, windows_studied: 7 } }} />);
    expect(screen.getByText(/read 7 of 10 parts of the document\. the job starts with what was read/i)).toBeInTheDocument();
  });

  it('states the cause of a failure and that the job can start without it', () => {
    render(<DocumentStudyCard status="error" {...props} error="The model route did not answer." />);
    expect(screen.getByText('The model route did not answer. The job can start without it, and will say so in its warnings.')).toBeInTheDocument();
  });

  it('renders nothing when the job reads no Study', () => {
    const { container } = render(<DocumentStudyCard status="skipped" {...props} />);
    expect(container).toBeEmptyDOMElement();
  });
});
