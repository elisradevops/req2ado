import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentOverviewCard } from './DocumentOverviewCard';

const OVERVIEW = {
  synopsis: 'Structure: 543 sections. All of the above is taken from the document’s text and structure; no AI was used.',
  caveat: 'The heading structure is unusually deep.',
  lines: ['Structure: 543 sections, 5 levels deep.', 'Unresolved values: TBD ×5.', 'All of the above is taken from the document’s text and structure; no AI was used.'],
  aiSummary: 'This text appears to be an ICD for a backplane. It covers power and thermal limits. A third sentence follows.',
};

describe('DocumentOverviewCard', () => {
  it('is collapsed by default: a heading, a one-line teaser and a button, and none of the long text', () => {
    render(<DocumentOverviewCard overview={OVERVIEW} />);
    expect(screen.getByText('Document overview')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /show/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/This text appears to be an ICD for a backplane\./)).toBeInTheDocument(); // the teaser: the summary's first sentence
    expect(screen.queryByText('Unresolved values: TBD ×5.')).not.toBeInTheDocument();
    expect(screen.queryByText(/unusually deep/)).not.toBeInTheDocument();
  });

  it('opens to the AI summary first, labelled, then the lines read off the file, then the caveat', async () => {
    render(<DocumentOverviewCard overview={OVERVIEW} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByRole('button', { name: /hide/i })).toHaveAttribute('aria-expanded', 'true');
    const text = document.body.textContent ?? '';
    expect(text.indexOf('AI summary')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('A third sentence follows.')).toBeLessThan(text.indexOf('Unresolved values: TBD ×5.'));
    expect(screen.getByText(/check it against the file/i)).toBeInTheDocument();
    expect(screen.getByText(/from the file’s text and structure/i)).toBeInTheDocument();
    expect(screen.getByText(/unusually deep/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /hide/i }));
    expect(screen.queryByText('Unresolved values: TBD ×5.')).not.toBeInTheDocument();
  });

  it('without an AI summary the teaser is the structure line, even when another line comes first', () => {
    const { aiSummary: _omit, ...plain } = OVERVIEW;
    render(<DocumentOverviewCard overview={{ ...plain, lines: ['No Scope, Purpose or Introduction section was found, so the file itself does not say what it is for.', ...plain.lines] }} />);
    expect(screen.getByTestId('overview-teaser')).toHaveTextContent(/^Structure: 543 sections, 5 levels deep\./);
  });

  it('without an AI summary the teaser is the structure line and there is no AI block', async () => {
    const { aiSummary: _omit, ...plain } = OVERVIEW;
    render(<DocumentOverviewCard overview={plain} />);
    expect(screen.getByText(/Structure: 543 sections, 5 levels deep\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.queryByText('AI summary')).not.toBeInTheDocument();
  });

  it('shows the joined synopsis for an overview stored before it had lines', async () => {
    render(<DocumentOverviewCard overview={{ synopsis: 'About a backplane.', caveat: null }} />);
    await userEvent.click(screen.getByRole('button', { name: /show/i }));
    expect(screen.getByText('About a backplane.')).toBeInTheDocument();
  });

  it('keeps the teaser to one short line', () => {
    render(<DocumentOverviewCard overview={{ ...OVERVIEW, aiSummary: `${'word '.repeat(80)}end.` }} />);
    const teaser = screen.getByTestId('overview-teaser');
    expect(teaser.textContent!.length).toBeLessThanOrEqual(160);
  });
});
