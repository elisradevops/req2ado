import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbHealthSummary } from './KbHealthSummary';
import type { KbProfile } from '../api/kb';
import type { KbProfileRead } from '../hooks/useKbProfile';

const profile = (overrides: Partial<KbProfile> = {}): KbProfile => ({
  state: 'ready', builtAt: '2026-11-12T09:10:00Z', version: 'v1', builtWith: 'model', docsInKb: 3, docsContributing: 2, truncated: false, docs: [], conflicts: [], ...overrides,
});
const read = (status: KbProfileRead['status'], p: KbProfile | null = null): KbProfileRead => ({ status, profile: p, refresh: vi.fn() });

function renderSummary(rubric: KbProfileRead, props: Partial<React.ComponentProps<typeof KbHealthSummary>> = {}) {
  const handlers = { onViewReport: vi.fn(), onCustomizeRubric: vi.fn() };
  render(<KbHealthSummary rubric={rubric} {...handlers} {...props} />);
  return handlers;
}

describe('KbHealthSummary', () => {
  it('says how much of the knowledge base the grading rubric draws on, and when it was built', () => {
    renderSummary(read('ready', profile()));

    expect(screen.getByText(/the grading rubric draws on 2 of 3 documents/i)).toBeInTheDocument();
    expect(screen.getByText(/built/i)).toBeInTheDocument();
  });

  it('says it is being updated, in one status region', () => {
    renderSummary(read('waiting', profile({ state: 'building' })));

    expect(screen.getByRole('status')).toHaveTextContent(/updating the grading rubric/i);
  });

  it.each([
    ['none', /no documents yet|no rubric yet/i],
    ['no_model', /no model connection/i],
    ['timeout', /still not updated/i],
    ['error', /could not read the rubric/i],
  ] as const)('says plainly when it is %s', (status, text) => {
    renderSummary(read(status));

    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows nothing while it first loads, instead of a wrong number', () => {
    renderSummary(read('loading'));

    expect(screen.queryByText(/draws on/i)).toBeNull();
  });

  it('opens the rubric for editing once it is built', async () => {
    const { onCustomizeRubric } = renderSummary(read('ready', profile()));

    await userEvent.click(screen.getByRole('button', { name: /customize the rubric/i }));

    expect(onCustomizeRubric).toHaveBeenCalled();
  });

  it('offers the last report only when there is one', async () => {
    const { onViewReport } = renderSummary(read('ready', profile()), { hasReport: true });

    await userEvent.click(screen.getByRole('button', { name: /view the last report/i }));

    expect(onViewReport).toHaveBeenCalled();
  });

  it('has no report button when there is no report', () => {
    renderSummary(read('ready', profile()), { hasReport: false });

    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
  });

  it('is one labelled region, so it can be found by a screen reader', () => {
    renderSummary(read('ready', profile()));

    expect(screen.getByRole('region', { name: /knowledge base health/i })).toBeInTheDocument();
  });
});
