import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import { CONNECTION_LOST_AFTER_MS, LONG_WAIT_AFTER_SECONDS, LiveRunPanel } from './LiveRunPanel';
import { FLUSH_INTERVAL_MS, useLiveRunStore } from '../../store/liveRunStore';
import { clearDocumentMapCache } from '../../hooks/useDocumentMap';
import { getRunDone, getRunMap } from '../../api/runMap';
import type { DocumentMap, LiveFrame } from '../../api/liveTypes';

vi.mock('../../api/runMap', () => ({ getRunMap: vi.fn(), getRunDone: vi.fn() }));
const mockedMap = vi.mocked(getRunMap);
const mockedDone = vi.mocked(getRunDone);

const MAP: DocumentMap = {
  version: 1, unit: 'headings', truncated: false, totalItems: 3,
  stats: { words: 915, blocks: 88, headings: 3, tables: 0, tableRows: 0, figures: 0, pages: 4 },
  groups: [],
  items: [
    { ref: 'r1', title: 'Chassis size', words: 40, depth: 0, type: 'Requirement' },
    { ref: 'r2', title: 'Ripple', words: 60, depth: 0, type: 'Requirement' },
    { ref: 'r3', title: 'Faults', words: 50, depth: 0, type: 'Requirement' },
  ],
};
const frame = (seq: number, lane: number, kind: LiveFrame['kind'], extra: Partial<LiveFrame> = {}): LiveFrame => ({
  type: 'live', seq, lane, kind, emittedAt: 'x', ...extra,
});
const flush = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
  });
};

describe('LiveRunPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLiveRunStore.getState().reset();
    useLiveRunStore.getState().begin('job-1');
    clearDocumentMapCache();
    mockedMap.mockReset();
    mockedMap.mockResolvedValue(null);
    mockedDone.mockReset();
    mockedDone.mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('renders nothing when the server has no live feature, so the banner is exactly as before', async () => {
    const { container } = render(<LiveRunPanel jobId='job-1' running />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the document in numbers and the outline once the map exists', async () => {
    mockedMap.mockResolvedValue(MAP);
    render(<LiveRunPanel jobId='job-1' running />);
    await flush();
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('915 words');
    expect(within(screen.getByTestId('document-outline')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByTestId('working-on-card')).not.toBeInTheDocument(); // no live frames yet
  });

  it('shows what is being worked on and moves the outline as items finish', async () => {
    mockedMap.mockResolvedValue(MAP);
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => {
      const s = useLiveRunStore.getState();
      s.ingestLive(frame(1, 0, 'item', { ref: 'r1', title: 'Chassis size' }));
      s.ingestLive(frame(2, 0, 'working_on', { ref: 'r2', excerpt: 'Ripple shall not exceed 50 mV.' }));
    });
    await flush();
    expect(screen.getByTestId('working-on-excerpt')).toHaveTextContent('Ripple shall not exceed 50 mV.');
    const rows = within(screen.getByTestId('document-outline')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Written: Chassis size');
    expect(rows[1]).toHaveTextContent('In progress: Ripple');
    expect(rows[2]).toHaveTextContent('Waiting: Faults');
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('1 of 3 outline items written');
    expect(screen.getByTestId('just-finished')).toHaveTextContent('Chassis size');
  });

  it('fills in the items finished before this page opened (a reload mid-run)', async () => {
    mockedMap.mockResolvedValue(MAP);
    mockedDone.mockResolvedValue(['r1', 'r2']);
    render(<LiveRunPanel jobId='job-1' running />);
    await flush();
    await flush();
    expect(mockedDone).toHaveBeenCalledWith('job-1');
    const rows = within(screen.getByTestId('document-outline')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Written: Chassis size');
    expect(rows[1]).toHaveTextContent('Written: Ripple');
    expect(rows[2]).toHaveTextContent('Waiting: Faults');
    expect(screen.getByTestId('document-metrics')).toHaveTextContent('2 of 3 outline items written');
  });

  it('does not ask for finished items when there is no map or the run is over', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    await flush();
    expect(mockedDone).not.toHaveBeenCalled();
    mockedMap.mockResolvedValue(MAP);
    clearDocumentMapCache();
    render(<LiveRunPanel jobId='job-2' running={false} />);
    await flush();
    expect(mockedDone).not.toHaveBeenCalled();
  });

  it('shows the live card without an outline when there is no map (older document map, or still loading)', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => useLiveRunStore.getState().ingestLive(frame(1, 0, 'working_on', { ref: 'x', title: 'Something' })));
    await flush();
    expect(screen.getByText('Something')).toBeInTheDocument();
    expect(screen.queryByTestId('document-outline')).not.toBeInTheDocument();
  });

  it('shows two texts side by side when the run finds a conflict or duplicate', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => {
      useLiveRunStore.getState().ingestLive(
        frame(1, 0, 'compare', {
          compare: { kind: 'conflict', similarity: 0.9, a: { ref: 'a', text: 'limit 5 V' }, b: { ref: 'b', text: 'limit 6 V' } },
        }),
      );
    });
    await flush();
    expect(screen.getByTestId('compare-pair')).toBeInTheDocument();
  });

  it('tells where each conflicting statement sits, from the outline', async () => {
    const outlined: DocumentMap = {
      ...MAP,
      items: [
        { ref: 'a0', title: 'Subsystem 1', words: 5, depth: 0, type: 'Epic' },
        { ref: 'a1', title: 'Function 1.1', words: 5, depth: 1, type: 'Feature' },
        { ref: 'r1', title: 'Chassis size', words: 40, depth: 2, type: 'Requirement' },
        { ref: 'r2', title: 'Ripple', words: 60, depth: 2, type: 'Requirement' },
      ],
    };
    mockedMap.mockResolvedValue(outlined);
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => {
      useLiveRunStore.getState().ingestLive(
        frame(1, 0, 'compare', {
          compare: { kind: 'conflict', similarity: 0.9, a: { ref: 'r1', text: 'limit 5 V' }, b: { ref: 'r2', text: 'limit 6 V' } },
        }),
      );
    });
    await flush();
    const pair = screen.getByTestId('compare-pair');
    expect(within(pair).getByRole('group', { name: 'Statement: Chassis size' })).toHaveTextContent('In: Subsystem 1 › Function 1.1');
    expect(within(pair).getByRole('group', { name: 'Statement: Ripple' })).toHaveTextContent('In: Subsystem 1 › Function 1.1');
  });

  it('says the connection is lost only after an error and 30 quiet seconds, as an alert', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => useLiveRunStore.getState().ingestLive(frame(1, 0, 'working_on', { ref: 'x' })));
    await flush();
    act(() => useLiveRunStore.getState().markError());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // a blip is not an outage
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONNECTION_LOST_AFTER_MS + 2000);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Connection lost — reconnecting');
    act(() => useLiveRunStore.getState().touch());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls out one long model request once heartbeats keep arriving with work in flight', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => {
      const s = useLiveRunStore.getState();
      s.ingestLive(frame(1, 0, 'working_on', { ref: 'x' }));
      s.ingestHeartbeat({ type: 'heartbeat', at: 'x', idleSeconds: LONG_WAIT_AFTER_SECONDS + 20, inFlight: [{ lane: 0, kind: 'working_on' }] });
    });
    await flush();
    expect(screen.getByTestId('long-wait-note')).toHaveTextContent('Still working — the model has been answering one long request for 1m 20s');
  });

  it('does not call out a long wait when nothing is in flight', async () => {
    render(<LiveRunPanel jobId='job-1' running />);
    act(() => {
      const s = useLiveRunStore.getState();
      s.ingestLive(frame(1, 0, 'working_on', { ref: 'x' }));
      s.ingestHeartbeat({ type: 'heartbeat', at: 'x', idleSeconds: 600, inFlight: [] });
    });
    await flush();
    expect(screen.queryByTestId('long-wait-note')).not.toBeInTheDocument();
  });

  it('shows the limits and adjustments row, naming the last finished item, only once a notice arrives', async () => {
    mockedMap.mockResolvedValue(MAP);
    render(<LiveRunPanel jobId='job-1' running />);
    await flush();
    expect(screen.queryByTestId('run-notices')).not.toBeInTheDocument();
    act(() => {
      useLiveRunStore.getState().ingestNotice({
        type: 'notice', id: 'n1', kind: 'output_limit_reached', severity: 'warning', count: 1,
        facts: { lastRef: 'r2' }, emittedAt: 'x',
      });
    });
    expect(screen.getByTestId('run-notices')).toHaveTextContent('Limits and adjustments');
    expect(screen.getByTestId('notice-output_limit_reached')).toHaveTextContent('The last item it finished was "Ripple"');
  });
});
