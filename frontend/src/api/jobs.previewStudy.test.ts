import { describe, it, expect, vi, beforeEach } from 'vitest';
import { previewStudy, StudyPreviewError } from './jobs';

vi.mock('./config', () => ({ loadRuntimeConfig: async () => ({ apiBaseUrl: '/api' }) }));

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const file = new File(['x'], 'x.docx');

describe('previewStudy', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports the parts read from the heartbeat lines and resolves to the Study, even with a line split across chunks', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(streamOf('{"type":"heartbeat","elapsed":1,"windowsDone":0,"windowsTotal":0}\n{"type":"heartbe', 'at","elapsed":2,"windowsDone":2,"windowsTotal":5}\n', '{"type":"result","study":{"stats":{"windows_total":5}}}\n'), { status: 200 }),
    );
    const progress = vi.fn();
    const result = await previewStudy({ file, mode: 'survey', model: 'm1', rulebookId: 'rb1' }, progress);
    expect(progress.mock.calls).toEqual([[2, 5]]); // a heartbeat before the server knows the parts is not progress
    expect(result).toEqual({ kind: 'study', study: { stats: { windows_total: 5 } } });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/jobs/preview/study');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    const form = (init as RequestInit).body as FormData;
    expect([form.get('mode'), form.get('model'), form.get('rulebookId')]).toEqual(['survey', 'm1', 'rb1']);
  });

  it('resolves to skipped when the job reads no Study', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamOf('{"type":"skipped"}\n'), { status: 200 }));
    expect(await previewStudy({ file, mode: 'baseline' }, vi.fn())).toEqual({ kind: 'skipped' });
  });

  it('rejects with the reason an error line or a refused request gives', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(streamOf('{"type":"error","status":502,"detail":"ingestion down"}\n'), { status: 200 }));
    await expect(previewStudy({ file, mode: 'survey' }, vi.fn())).rejects.toEqual(new StudyPreviewError('ingestion down', 502));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ message: 'mode must be baseline or survey' }), { status: 400 }));
    await expect(previewStudy({ file, mode: 'survey' }, vi.fn())).rejects.toMatchObject({ message: 'mode must be baseline or survey', status: 400 });
  });
});
