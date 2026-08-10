import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DestinationBar, formatDestinationPreview } from './DestinationBar';

describe('DestinationBar', () => {
  it('renders nothing when neither teamProject nor areaPath is given', () => {
    const { container } = render(<DestinationBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the team project, and the area path\'s leaf when it is nested', () => {
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath="Elisra\EW\SRD\Receiver" />);
    expect(screen.getByText('Elisra EW Programs')).toBeInTheDocument();
    expect(screen.getByText('…\\Receiver')).toBeInTheDocument();
  });

  // Confirmed live, reported directly: end-truncation ("some area\sub
  // area\su…") cut off the one part a reviewer actually recognizes. Shows
  // just the leaf instead, unconditionally on depth, not on measured
  // width -- deterministic and scannable beats "sometimes full, sometimes
  // cut" depending on container size.
  it('shows only the leaf segment of a deeply nested area path, not an end-truncated prefix of it', () => {
    const deepPath = 'Elisra EW Programs\\some area\\sub area\\sub sub area\\Customer Requirements';
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath={deepPath} />);
    expect(screen.getByText('…\\Customer Requirements')).toBeInTheDocument();
    expect(screen.queryByText('some area\\sub area\\sub sub area\\Customer Requirements')).not.toBeInTheDocument();
    expect(screen.queryByText(/some area\\sub area\\su/)).not.toBeInTheDocument();
  });

  it('can shrink/ellipsize even the leaf-only display instead of overflowing the row -- jsdom has no real layout engine, so this checks the CSS mechanism, not pixels', () => {
    // Confirmed live: a real, legitimate ADO depth forced the whole page
    // into horizontal scroll instead of truncating -- `flex-none` on the
    // segment disabled shrinking outright, so the value's own `truncate`
    // never got a chance to run. min-w-0 is what actually lets a flex
    // child shrink below its content's natural width; flex-none's
    // flex-shrink:0 blocks that regardless of min-w-0 being present too.
    // The leaf-only display (above) makes this rarer to hit in practice,
    // but a single long leaf segment name is still real, unbounded input.
    const deepPath = 'Elisra EW Programs\\some area\\sub area\\sub sub area\\Customer Requirements';
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath={deepPath} />);
    const value = screen.getByText('…\\Customer Requirements');
    expect(value.className).toContain('truncate');
    expect(value.className).toContain('min-w-0');
    expect(value.className).not.toContain('flex-none');
    const segment = value.closest('.hoverable-row');
    expect(segment?.className).not.toContain('flex-none');
    expect(segment?.className).toMatch(/min-w-0/);
  });

  it('puts the full, untruncated value in this app\'s own fast tooltip, not the native title attribute', () => {
    // Confirmed live, reported directly: native `title` has a real,
    // noticeable OS-level show delay ("taking too much time to load").
    // Tooltip.tsx's Radix primitive is tuned to 200ms -- a strict
    // improvement, not a tradeoff, and it's already this app's one
    // standard way to show a value's full form on hover (JobsList's own
    // area-path cell uses the same component for the same reason).
    const deepPath = 'Elisra EW Programs\\some area\\sub area\\sub sub area\\Customer Requirements';
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath={deepPath} />);
    const value = screen.getByText('…\\Customer Requirements');
    expect(value).not.toHaveAttribute('title');
    // Radix's Trigger (asChild) clones its real wiring directly onto this
    // element -- data-state (open/closed) only appears via that mechanism.
    expect(value).toHaveAttribute('data-state');
  });

  // DESIGN.md §11.2.2 -- each segment now carries its own uppercase key label
  // (PROJECT/AREA/...), unlike the old undifferentiated single-line
  // breadcrumb this dedup guarded (where the SAME unlabeled value twice in
  // a row genuinely read as a rendering bug, not two real, distinct facts).
  // Showing the same value under two clearly-labeled segments is a real
  // state (the area path happens to equal the team project name), not a
  // repeat to hide.
  it('shows the area path under its own segment even when it is identical to the team project', () => {
    render(<DestinationBar teamProject="Elisra EW Programs" areaPath="Elisra EW Programs" />);
    expect(screen.getAllByText('Elisra EW Programs').length).toBeGreaterThanOrEqual(2);
  });

  it('uses a custom label when provided', () => {
    render(<DestinationBar label="Importing into" teamProject="Elisra EW Programs" />);
    expect(screen.getByText('Importing into')).toBeInTheDocument();
  });

  it('strips the project prefix from the area/iteration segments themselves, not just the preview line below', () => {
    render(
      <DestinationBar
        teamProject="Radar Systems"
        areaPath="Radar Systems\EW Suite"
        iterationPath="Radar Systems\Rev C"
        state="Proposed"
      />,
    );
    // Confirmed live: these segments still showed the raw, project-prefixed
    // value ("Radar Systems\Rev C") right next to a Project segment already
    // showing "Radar Systems" -- the preview line below already stripped
    // it, this fixes the segments to match instead of repeating it twice
    // more above that line.
    expect(screen.getByText('EW Suite')).toBeInTheDocument();
    expect(screen.getByText('Rev C')).toBeInTheDocument();
    expect(screen.queryByText('Radar Systems\\EW Suite')).not.toBeInTheDocument();
    expect(screen.queryByText('Radar Systems\\Rev C')).not.toBeInTheDocument();
    expect(screen.getByText('Proposed')).toBeInTheDocument();
  });

  it('hatches the iteration segment instead of leaving it blank when unset', () => {
    render(<DestinationBar teamProject="Radar Systems" areaPath="Radar Systems\EW Suite" />);
    expect(screen.getByLabelText('Iteration not set')).toBeInTheDocument();
  });

  it('never hatches the state segment when unset -- state is not optional the way iteration is', () => {
    render(<DestinationBar teamProject="Radar Systems" areaPath="Radar Systems\EW Suite" />);
    expect(screen.queryByLabelText('State not set')).not.toBeInTheDocument();
  });

  it('does not render a mono preview line below the segments -- confirmed live as duplicated information once the segments themselves show the correct, deduped values', () => {
    render(
      <DestinationBar
        teamProject="Radar Systems"
        areaPath="Radar Systems\EW Suite"
        iterationPath="Radar Systems\Rev C"
        state="Proposed"
      />,
    );
    expect(screen.queryByText('Radar Systems \\ EW Suite \\ Rev C · state Proposed')).not.toBeInTheDocument();
  });

  it('does not hatch the iteration segment as "not set" when iteration IS set, to the project root', () => {
    // The strip helper returns null for this exact-equality case (see the
    // regression test above) -- the Iteration segment must fall back to the
    // raw value here, not treat that null as "unset." A real root iteration
    // hatched as missing would misreport a deliberate destination as a
    // broken one.
    render(<DestinationBar teamProject="Radar Systems" areaPath="Radar Systems" iterationPath="Radar Systems" state="Proposed" />);
    expect(screen.queryByLabelText('Iteration not set')).not.toBeInTheDocument();
    expect(screen.getAllByText('Radar Systems').length).toBeGreaterThanOrEqual(3);
  });
});

// No longer rendered inside DestinationBar itself (see the test above) --
// still exported and used directly by NewJobWizard's step-2 card, whose own
// 4 fields are editable inputs, not labeled read-only boxes, so ONE mono
// "read it back" line there is genuinely the sole restatement, not a
// second one. Tested here as the pure function it now only is.
describe('formatDestinationPreview', () => {
  it('restates the full resolved destination as one mono line, without repeating the project name that already prefixes areaPath/iterationPath', () => {
    // Real bug fixed here (confirmed live): ADO area/iteration paths are
    // ALWAYS project-prefixed ("Radar Systems\EW Suite", never a bare "EW
    // Suite") -- this fixture's shape is the real one, not a simplified
    // one. The old naive join repeated "Radar Systems" up to 3 times in
    // this exact line, reported live as "looking very bad."
    expect(formatDestinationPreview('Radar Systems', 'Radar Systems\\EW Suite', 'Radar Systems\\Rev C', 'Proposed')).toBe(
      'Radar Systems \\ EW Suite \\ Rev C · state Proposed',
    );
  });

  it('omits unset segments rather than showing a confusing blank', () => {
    expect(formatDestinationPreview('Radar Systems', 'Radar Systems\\EW Suite', undefined, undefined)).toBe('Radar Systems \\ EW Suite');
  });

  it('does not repeat the project name when the area path IS the project root (no "\\Sub" suffix at all)', () => {
    // Real bug found on review: the prefix-strip only matched paths shaped
    // "Project\Sub" (a leading `${teamProject}\` match) -- a project's own
    // ROOT area/iteration has no backslash suffix at all, areaPath equals
    // teamProject EXACTLY. That's real, common ADO state (any project where
    // no custom sub-area was ever created), and it fell straight through
    // unstripped, reprinting the project name a second time -- the exact
    // "looking very bad" bug this function exists to prevent, just for a
    // different input shape than the other regression test above covers.
    expect(formatDestinationPreview('Radar Systems', 'Radar Systems', 'Radar Systems', 'Proposed')).toBe('Radar Systems · state Proposed');
  });
});
