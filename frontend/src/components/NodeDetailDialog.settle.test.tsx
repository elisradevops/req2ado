import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { NodeDetailDialog } from './NodeDetailDialog';
import { ToastProvider } from './ToastProvider';
import type { DryRunDiffEntry } from './DiffTree';
import * as chatApi from '../api/chat';
import * as jobsApi from '../api/jobs';

const { animateSpy, scope } = vi.hoisted(() => ({ animateSpy: vi.fn(), scope: { current: null as HTMLElement | null } }));

// Capture the settle animation; the real motion/mini drives the Web Animations API, which jsdom does not have.
vi.mock('motion/react-mini', () => ({ useAnimate: () => [scope, animateSpy] }));
vi.mock('../api/chat');
vi.mock('../api/jobs');
vi.mock('../hooks/useChatSocket', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useChatSocket')>('../hooks/useChatSocket');
  return { ...actual, useChatSocket: vi.fn() };
});

const entry = (localId: string): DryRunDiffEntry =>
  ({ localId, parentLocalId: null, type: 'Requirement', title: `Req ${localId}`, description: '', action: 'create', customerId: null, tags: [] }) as DryRunDiffEntry;

function dialog(e: DryRunDiffEntry): React.ReactElement {
  return (
    <ToastProvider>
      <NodeDetailDialog open onOpenChange={vi.fn()} jobId="job-1" entry={e} onAddChild={vi.fn()} />
    </ToastProvider>
  );
}

describe('NodeDetailDialog item settle (DESIGN.md section 8.3)', () => {
  let now = 1000;
  beforeEach(() => {
    animateSpy.mockClear();
    vi.mocked(chatApi.getChatHistory).mockResolvedValue([]);
    vi.mocked(chatApi.listModels).mockResolvedValue([]);
    vi.mocked(jobsApi.getFigureFile).mockResolvedValue(null);
    (HTMLElement.prototype as unknown as { animate: () => object }).animate = () => ({});
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
    vi.restoreAllMocks();
  });

  it('fades opacity only, 0.7 to 1 over 110 ms, with no movement', () => {
    const { rerender } = render(dialog(entry('a')));
    rerender(dialog(entry('b')));
    expect(animateSpy).toHaveBeenCalledTimes(1);
    const [, keyframes, options] = animateSpy.mock.calls[0];
    expect(keyframes).toEqual({ opacity: [0.7, 1] });
    expect(options).toMatchObject({ duration: 0.11 });
  });

  it('does not animate the first item shown', () => {
    render(dialog(entry('a')));
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it('skips the effect on rapid repeats, so holding J or K stays still', () => {
    const { rerender } = render(dialog(entry('a')));
    rerender(dialog(entry('b')));
    now += 100;
    rerender(dialog(entry('c')));
    now += 100;
    rerender(dialog(entry('d')));
    expect(animateSpy).toHaveBeenCalledTimes(1);
    now += 600;
    rerender(dialog(entry('e')));
    expect(animateSpy).toHaveBeenCalledTimes(2);
  });
});
