import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDetailDialog } from '../components/NodeDetailDialog';
import { ToastProvider } from '../components/ToastProvider';
import type { DryRunDiffEntry } from '../components/DiffTree';
import * as chatApi from '../api/chat';
import * as jobsApi from '../api/jobs';

// WCAG 1.4.12 (text spacing) regression guard, DESIGN.md §13. A reader who raises line height to 1.5, paragraph spacing to 2x, letter
// spacing to 0.12em and word spacing to 0.16em must lose no content. jsdom does no layout, so this cannot measure that; what it CAN check
// is the cause of every real failure of this kind: a box with a fixed height that clips the text inside it. It fails if prose, or any box
// that holds prose, gets a fixed height in px (or a fixed rung) together with clipping, or a line clamp. A height that GROWS (min-h-*) and a
// scroll container (overflow-auto) are fine. Real layout under the text-spacing bookmarklet was not measured.

vi.mock('../api/chat');
vi.mock('../api/jobs');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

const FIXED_HEIGHT = /(^|\s)(max-)?h-(\[\d+(\.\d+)?px\]|\d+(\.\d+)?)(?=\s|$)/;
const CLIPS = /(^|\s)(overflow-hidden|overflow-clip|truncate|line-clamp-\d+)(?=\s|$)/;

// The first offending class list between a prose element and the dialog root, or null.
function clippingBoxAbove(element: Element, root: Element): string | null {
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    const cls = node.getAttribute('class') ?? '';
    if (/(^|\s)line-clamp-\d+/.test(cls)) return cls;
    if (FIXED_HEIGHT.test(cls) && CLIPS.test(cls)) return cls;
    const style = (node as HTMLElement).style;
    if (style && style.height && style.height.endsWith('px') && CLIPS.test(cls)) return `${cls} style=height:${style.height}`;
  }
  return null;
}

const LONG = 'The system shall record the time source used for every synchronisation event and expose it to the operator. '.repeat(6);

const ENTRY: DryRunDiffEntry = {
  localId: 'e1', parentLocalId: null, type: 'Requirement', title: 'Time sync source', description: LONG, action: 'create', customerId: 'R-1', tags: [],
  sourceRef: { documentPath: 'spec.docx', startOffset: 0, endOffset: 5, page: 2 },
  qualityScore: 40, qualityCategoryScores: { testability: 35, clarity: 80 }, qualityIssues: ['not_testable'], groundingScore: 0.2,
  proposal: { kind: 'criteria', html: `<div data-r2a="criteria"><ul><li>${LONG}</li></ul></div>` },
};

describe('text spacing (WCAG 1.4.12): no prose sits in a fixed-height box that clips it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    vi.mocked(jobsApi.getFigureFile).mockResolvedValue(null);
  });

  it('the item dialog: description, proposal, evidence and the opened "Why this verdict" region', () => {
    render(
      <ToastProvider>
        <NodeDetailDialog open onOpenChange={vi.fn()} jobId="job-1" entry={ENTRY} jobMode="survey" onAddChild={vi.fn()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /why this verdict/i }));
    const root = screen.getByRole('dialog');
    const prose = Array.from(root.querySelectorAll('p, li, .text-read'));
    expect(prose.length).toBeGreaterThan(5);
    const offenders = prose.map((el) => clippingBoxAbove(el, root)).filter((x): x is string => x !== null);
    expect(offenders).toEqual([]);
  });

  it('would catch the offence it exists for', () => {
    const { container } = render(
      <div data-root>
        <div className="h-[64px] overflow-hidden">
          <p>{LONG}</p>
        </div>
        <p className="line-clamp-2">{LONG}</p>
        <div className="min-h-[300px] overflow-y-auto">
          <p>fine: grows, and scrolls rather than clips</p>
        </div>
      </div>,
    );
    const root = container.querySelector('[data-root]')!;
    const hits = Array.from(root.querySelectorAll('p')).map((el) => clippingBoxAbove(el, root));
    expect(hits[0]).toContain('h-[64px]');
    expect(hits[1]).toContain('line-clamp-2');
    expect(hits[2]).toBeNull();
  });

  // The prose-bearing sources: no pixel-fixed height at all, so the next edit cannot add one without failing here.
  it.each([
    'components/NodeDetailPanel.tsx',
    'components/NodeDetailDialog.tsx',
    'components/EvidenceStrip.tsx',
    'components/ProposalCard.tsx',
    'components/SourceProvenance.tsx',
    'components/QualityGauge.tsx',
    'components/ScoreExplanationPanel.tsx',
    'components/WriteBar.tsx',
    'ui/Disclosure.tsx',
  ])('%s sets no h-[Npx] or max-h-[Npx]', (file) => {
    const source = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(source.match(/(?<![\w-])(max-)?h-\[\d+(\.\d+)?px\]/g) ?? []).toEqual([]);
  });
});
