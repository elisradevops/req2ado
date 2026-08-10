import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QualityGauge } from './QualityGauge';

describe('QualityGauge', () => {
  it('renders the overall score and band without a category breakdown', () => {
    render(<QualityGauge score={40} />);
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getAllByText('Needs rework').length).toBeGreaterThan(0);
    expect(screen.queryByText('Clarity')).not.toBeInTheDocument();
  });

  it('renders the real per-category breakdown when supplied, answering "why is this 40"', () => {
    render(
      <QualityGauge
        score={40}
        categoryScores={{ clarity: 20, testability: 80, atomicity: 90, style: 60, rationale: 10 }}
      />,
    );
    expect(screen.getByText('Clarity')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('Testability')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByText('Atomicity')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('Style')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('Rationale')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('omits the breakdown section entirely when categoryScores is null', () => {
    render(<QualityGauge score={90} categoryScores={null} />);
    expect(screen.queryByText('Clarity')).not.toBeInTheDocument();
  });

  it('renders KB-derived dynamic category names, not just the fixed 5-dimension fallback', () => {
    // Confirmed real gap fixed: an org's ingested quality-checklist
    // standard (e.g. Necessary/Unambiguous/Verifiable) can define entirely
    // different category names than the generic clarity/testability/
    // atomicity/style/rationale fallback -- the gauge must render whatever
    // keys the scoring response actually returned.
    render(
      <QualityGauge
        score={72}
        categoryScores={{ Necessary: 90, Unambiguous: 55, Verifiable: 80 }}
      />,
    );
    expect(screen.getByText('Necessary')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('Unambiguous')).toBeInTheDocument();
    expect(screen.getByText('55')).toBeInTheDocument();
    expect(screen.getByText('Verifiable')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.queryByText('Clarity')).not.toBeInTheDocument();
  });

  it('omits the breakdown section when categoryScores is an empty object', () => {
    render(<QualityGauge score={90} categoryScores={{}} />);
    expect(screen.queryByText('Clarity')).not.toBeInTheDocument();
  });

  it('humanizes a snake_case KB-derived category key into space-separated words', () => {
    // Regression: categoryLabel previously only uppercased the first
    // character, leaving "completeness_as_requirement" (a real ADO org's
    // own ingested checklist key) rendered as the literal, underscore-
    // joined "Completeness_as_requirement".
    render(<QualityGauge score={72} categoryScores={{ completeness_as_requirement: 40 }} />);
    expect(screen.getByText('Completeness As Requirement')).toBeInTheDocument();
    expect(screen.queryByText(/completeness_as_requirement/i)).not.toBeInTheDocument();
  });

  // DESIGN.md §11.4.3 point 3 / CR-7c -- per-metric "why is this number
  // what it is" via the real, already-written fix-oriented remedy text
  // (utils/labels.ts), grouped under the category bar it actually explains
  // (utils/qualityCategories.ts's conservative mapping) rather than an
  // unranked chip cloud three components away.
  describe('per-category issue breakdown', () => {
    it('groups a mapped issue code under its real category row, not under "Other flags"', () => {
      render(
        <QualityGauge
          score={40}
          categoryScores={{ clarity: 20, testability: 80, atomicity: 90, style: 60, rationale: 10 }}
          qualityIssues={['vague_term']}
        />,
      );
      // ambiguous/vague_term map to clarity (qualityCategories.ts) -- the
      // remedy text is present in the DOM (grid-rows-[0fr] collapses
      // visually, it does not unmount) even before expanding.
      expect(screen.getByText(/replace with a measurable value/)).toBeInTheDocument();
      expect(screen.queryByText('Other flags')).not.toBeInTheDocument();
    });

    it('puts an unmapped issue code (not about a single wording dimension) into "Other flags", never a guessed category', () => {
      render(
        <QualityGauge
          score={40}
          categoryScores={{ clarity: 20, testability: 80, atomicity: 90, style: 60, rationale: 10 }}
          qualityIssues={['conflicting_value']}
        />,
      );
      expect(screen.getByText('Other flags')).toBeInTheDocument();
      expect(screen.getByText(/resolve the conflict before this can be finalized/)).toBeInTheDocument();
    });

    it('falls back every issue to "Other flags" when there is no categoryScores to map against at all', () => {
      render(<QualityGauge score={40} qualityIssues={['vague_term']} />);
      expect(screen.getByText('Other flags')).toBeInTheDocument();
    });

    it('toggles the disclosure open/closed on click -- every row can expand, even one with no mapped issue, since it always has its own definition to show', async () => {
      render(
        <QualityGauge
          score={40}
          categoryScores={{ clarity: 20, testability: 80 }}
          qualityIssues={['vague_term']}
        />,
      );
      const clarityToggle = screen.getByRole('button', { name: /clarity/i });
      expect(clarityToggle).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(clarityToggle);
      expect(clarityToggle).toHaveAttribute('aria-expanded', 'true');

      // Testability has no mapped issue, but DESIGN.md §11.4.3 moved the
      // category's plain-language definition out of an InfoTip and onto
      // the row itself -- every row has a definition, so every row can
      // expand, not only ones with a flag to show.
      const testabilityToggle = screen.getByRole('button', { name: /testability/i });
      expect(testabilityToggle).not.toBeDisabled();
      expect(testabilityToggle).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(testabilityToggle);
      expect(screen.getByText(/can this be objectively verified/i)).toBeInTheDocument();
    });

    it('shows the category\'s plain-language definition as real text on the row, not hidden behind an InfoTip hover', () => {
      render(<QualityGauge score={40} categoryScores={{ clarity: 20 }} />);
      // Present in the DOM regardless of expanded state (grid-rows-[0fr]
      // collapses visually, it does not unmount) -- the definition is no
      // longer InfoTip-only content a reviewer has to hover to see.
      expect(screen.getByText(/free of vague terms/i)).toBeInTheDocument();
    });
  });

  // CR-7d rescore: "Rescored" shows a real before/after delta, not just the
  // new number with no context for what changed.
  describe('rescore delta', () => {
    it('shows a signed delta chip and the previous value for the overall score and each moved category', () => {
      render(
        <QualityGauge
          score={80}
          categoryScores={{ clarity: 80 }}
          previousScore={40}
          previousCategoryScores={{ clarity: 20 }}
        />,
      );
      expect(screen.getByText('(was 40)')).toBeInTheDocument();
      expect(screen.getByText('▲ +40')).toBeInTheDocument(); // headline delta
      expect(screen.getByText('▲ +60')).toBeInTheDocument(); // clarity: 20 -> 80
      // Overall score header + Clarity's own row -- both now read 80.
      expect(screen.getAllByText('80').length).toBe(2);
    });

    it('shows "no change" on the headline (never a bare +0) but no ornament at all on an unmoved category row', () => {
      render(<QualityGauge score={80} categoryScores={{ clarity: 20, style: 80 }} previousScore={80} previousCategoryScores={{ clarity: 50, style: 80 }} />);
      expect(screen.getByText('no change')).toBeInTheDocument(); // headline: 80 -> 80
      expect(screen.getByText('▼ -30')).toBeInTheDocument(); // clarity: 50 -> 20
      // style (80 -> 80, unmoved) gets no delta ornament at all -- decorating
      // an unchanged row would drown out the one that actually moved.
      expect(screen.queryByText('▲ +0')).not.toBeInTheDocument();
    });

    it('shows the headline as "no change" (with no "(was N)" suffix) when the whole gauge is unchanged', () => {
      render(<QualityGauge score={80} categoryScores={{ clarity: 80 }} previousScore={80} previousCategoryScores={{ clarity: 80 }} />);
      expect(screen.getByText('no change')).toBeInTheDocument();
      expect(screen.queryByText(/^\(was /)).not.toBeInTheDocument();
      // No category row shows any delta ornament -- clarity didn't move.
      expect(screen.queryByText(/^▲|^▼/)).not.toBeInTheDocument();
    });

    it('shows no delta outside the post-rescore window (previousScore/previousCategoryScores omitted)', () => {
      render(<QualityGauge score={80} categoryScores={{ clarity: 80 }} />);
      expect(screen.queryByText(/^was /)).not.toBeInTheDocument();
    });

    it('names a headline band crossing in words, only when the band actually changed', () => {
      render(<QualityGauge score={80} previousScore={40} />); // Needs rework -> Solid
      expect(screen.getByText('Moved from Needs rework into Solid.')).toBeInTheDocument();
    });

    it('never names a band crossing when the score moved but stayed in the same band', () => {
      render(<QualityGauge score={80} previousScore={78} />); // both Solid
      expect(screen.queryByText(/^Moved from/)).not.toBeInTheDocument();
    });

    it('names a per-category band crossing, but only on the row that actually crossed', () => {
      render(
        <QualityGauge
          score={80}
          categoryScores={{ clarity: 80, style: 60 }} // clarity crosses into Solid, style stays in Needs review
          previousScore={80}
          previousCategoryScores={{ clarity: 40, style: 55 }}
        />,
      );
      expect(screen.getByText('Moved from Needs rework into Solid.')).toBeInTheDocument();
      // style: 55 -> 60 is a real move (shows its numeral delta) but neither
      // value leaves "Needs review" -- no crossing sentence for that row.
      const crossingSentences = screen.getAllByText(/^Moved from/);
      expect(crossingSentences).toHaveLength(1);
    });

    it('shows "Cleared: <flag>" under the category a cleared issue belonged to, always visible without needing to expand', () => {
      render(
        <QualityGauge
          score={80}
          categoryScores={{ clarity: 80 }}
          qualityIssues={[]}
          previousScore={40}
          previousCategoryScores={{ clarity: 20 }}
          previousIssues={['vague_term']}
        />,
      );
      // vague_term maps to clarity and is gone from qualityIssues now.
      expect(screen.getByText('Cleared: Vague term')).toBeInTheDocument();
    });

    it('shows a cleared, unmapped issue under "Other flags", never guessed onto a category', () => {
      render(
        <QualityGauge
          score={80}
          categoryScores={{ clarity: 80 }}
          qualityIssues={[]}
          previousIssues={['conflicting_value']}
        />,
      );
      expect(screen.getByText('Cleared: Conflicting value')).toBeInTheDocument();
    });

    it('never shows a flag as cleared when it is still present in the current qualityIssues', () => {
      render(
        <QualityGauge
          score={80}
          categoryScores={{ clarity: 80 }}
          qualityIssues={['vague_term']}
          previousIssues={['vague_term']}
        />,
      );
      expect(screen.queryByText(/^Cleared:/)).not.toBeInTheDocument();
    });
  });
});
