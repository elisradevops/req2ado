import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
