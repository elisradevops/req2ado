import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forwardRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { JobDetail } from './JobDetail';
import { ToastProvider } from '../components/ToastProvider';
import * as jobsApi from '../api/jobs';

// CR: reparent -- real user feedback after deploying: drag-and-drop felt
// laggy because it waited on a full server round-trip before the row
// visually moved. Verifies the fix end-to-end through JobDetail's real
// DiffTree: the move applies to the tree immediately, and reverts if the
// server rejects it.
//
// Separate file from JobDetail.test.tsx (not just a describe block there)
// because it needs react-window mocked -- the REAL FixedSizeList's own
// virtualization math doesn't run meaningfully in jsdom (no real layout),
// which made native-DnD row lookups unreliable. Same mock DiffTree.test.tsx
// already uses and has proven reliable for exactly this kind of
// drag-and-drop interaction; kept isolated here so it can't change
// behavior for JobDetail.test.tsx's other, unrelated tests.
vi.mock('react-window', () => ({
  FixedSizeList: forwardRef<
    unknown,
    { itemCount: number; children: (args: { index: number; style: CSSProperties }) => ReactNode }
  >((props, ref) => {
    if (typeof ref === 'function') ref({ scrollToItem: () => {} });
    else if (ref) (ref as { current: unknown }).current = { scrollToItem: () => {} };
    return (
      <div>
        {Array.from({ length: props.itemCount }, (_, index) => (
          <div key={index}>{props.children({ index, style: {} })}</div>
        ))}
      </div>
    );
  }),
}));

vi.mock('../api/jobs');
vi.mock('../api/chat');
vi.mock('../api/events', async () => {
  const actual = await vi.importActual<typeof import('../api/events')>('../api/events');
  return { ...actual, subscribeToJobEvents: vi.fn(() => () => {}) };
});
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

function renderAt(id: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/jobs/${id}`]}>
        <Routes>
          <Route path="/jobs/:id" element={<JobDetail />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

function rowFor(title: string): HTMLElement {
  return screen.getByText(title).closest('[role="treeitem"]') as HTMLElement;
}
// @dnd-kit/core's own rect measurement (the dragged row's initial rect, and
// every droppable row's rect at drag start) needs a real, distinct
// getBoundingClientRect per row -- see DiffTree.test.tsx's own stubRowRect
// for the full explanation (jsdom otherwise reports every element's rect as
// all-zero, which would make every row's collision distance identical).
function stubRowRect(el: HTMLElement, top: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top, height: 40, bottom: top + 40, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}),
  } as DOMRect);
}
// @dnd-kit/core's MouseSensor drives a drag from real mousedown/mousemove/
// mouseup events -- see DiffTree.test.tsx's own dragRow for the full
// explanation (jsdom has no real PointerEvent, which is why the component
// uses MouseSensor rather than PointerSensor). move/end listeners attach to
// `document`.
function dragRow(source: HTMLElement, opts: { fromY: number; toY: number }): void {
  fireEvent.mouseDown(source, { button: 0, clientX: 100, clientY: opts.fromY });
  fireEvent.mouseMove(document, { clientX: 100, clientY: opts.fromY + 10 });
  fireEvent.mouseMove(document, { clientX: 100, clientY: opts.toY });
  fireEvent.mouseUp(document, { clientX: 100, clientY: opts.toY });
}

const EPIC1 = { localId: 'e1', parentLocalId: null, type: 'Epic', title: 'Epic One', description: '', action: 'create', customerId: null };
const EPIC2 = { localId: 'e2', parentLocalId: null, type: 'Epic', title: 'Epic Two', description: '', action: 'create', customerId: null };
const FEATURE1 = { localId: 'f1', parentLocalId: 'e1', type: 'Feature', title: 'Feature One', description: '', action: 'create', customerId: null };

describe('JobDetail optimistic move on drag-and-drop', () => {
  beforeEach(() => {
    vi.spyOn(jobsApi, 'getSummary').mockResolvedValue({ created: 0, reused: 0, dedupSkipped: 0, flagged: 0, warnings: [] });
    vi.spyOn(jobsApi, 'getEventHistory').mockResolvedValue([]);
    vi.spyOn(jobsApi, 'getFigureFile').mockResolvedValue(null);
  });

  it('moves the row immediately on drop, before the server responds', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-50',
      status: 'diff_ready',
      mode: 'survey',
      dryRunDiff: [EPIC1, EPIC2, FEATURE1],
    } as any);
    // Never resolves within this test -- isolates the IMMEDIATE,
    // pre-response state.
    vi.mocked(jobsApi.moveDiffEntry).mockReturnValue(new Promise(() => {}));
    renderAt('job-50');
    await waitFor(() => expect(screen.getByText('Feature One')).toBeInTheDocument());

    // buildFlatRows order for [Epic One, Epic Two, Feature One] (Feature
    // One is Epic One's child): Epic One(top=0), Feature One(top=40), Epic
    // Two(top=80).
    const source = rowFor('Feature One'); // center=60
    stubRowRect(source, 40);
    stubRowRect(rowFor('Epic One'), 0);
    stubRowRect(rowFor('Epic Two'), 80); // center=100

    dragRow(source, { fromY: 0, toY: 100 - 60 }); // dead center of Epic Two -> 'inside'

    // Feature One now renders nested under Epic Two, not Epic One --
    // applied locally, with no awaited response yet.
    const epic2Row = rowFor('Epic Two');
    const featureRow = rowFor('Feature One');
    expect(epic2Row.compareDocumentPosition(featureRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(jobsApi.moveDiffEntry).toHaveBeenCalledWith('job-50', 'f1', { parentLocalId: 'e2' });
  });

  it('reverts the move when the server rejects it', async () => {
    vi.spyOn(jobsApi, 'getJob').mockResolvedValue({
      id: 'job-51',
      status: 'diff_ready',
      mode: 'survey',
      dryRunDiff: [EPIC1, EPIC2, FEATURE1],
    } as any);
    vi.mocked(jobsApi.moveDiffEntry).mockRejectedValue(new Error('already linked'));
    renderAt('job-51');
    await waitFor(() => expect(screen.getByText('Feature One')).toBeInTheDocument());

    const source = rowFor('Feature One'); // center=60
    stubRowRect(source, 40);
    stubRowRect(rowFor('Epic One'), 0);
    stubRowRect(rowFor('Epic Two'), 80); // center=100

    dragRow(source, { fromY: 0, toY: 100 - 60 }); // dead center of Epic Two -> 'inside'

    // Reverts back under Epic One once the rejection resolves. Checked
    // against Epic Two specifically (not just "follows Epic One", which
    // is ALSO true of the un-reverted state, since Epic Two itself follows
    // Epic One regardless -- this assertion previously passed even with
    // the revert deliberately removed, caught by mutation-testing it):
    // buildFlatRows's depth-first order for [Epic One, Epic Two, Feature
    // One] is Epic One -> Feature One (its child) -> Epic Two once
    // reverted, vs. Epic One -> Epic Two -> Feature One (now Epic Two's
    // child) if the optimistic move had incorrectly stuck.
    await waitFor(() => expect(screen.getByText(/failed to move/i)).toBeInTheDocument());
    const epic2Row = rowFor('Epic Two');
    const featureRow = rowFor('Feature One');
    expect(epic2Row.compareDocumentPosition(featureRow) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
