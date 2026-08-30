import { computeDeterministicCaveat, DocumentOverviewService } from '../src/modules/pipeline/document-overview.service';
import type { DocumentMapSection } from '../src/modules/pipeline/document-map';

function section(blockCount: number): DocumentMapSection {
  return { number: null, title: 'Section', blockCount, figureCount: 0 };
}

describe('computeDeterministicCaveat', () => {
  it('returns null for a small, shallow document', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 2, documentMap)).toBeNull();
  });

  it('returns a caveat when max heading depth is unusually deep', () => {
    const documentMap = Array.from({ length: 6 }, () => section(10));
    expect(computeDeterministicCaveat(6, 5, documentMap)).not.toBeNull();
  });

  it('returns a caveat when the document is large and fragmented (many tiny sections)', () => {
    // Mirrors the real AirPro ICD shape used throughout this feature's
    // design review: 79 sections, most with 0-2 blocks.
    const documentMap = [
      ...Array.from({ length: 50 }, () => section(1)),
      ...Array.from({ length: 29 }, () => section(20)),
    ];
    expect(computeDeterministicCaveat(79, 3, documentMap)).not.toBeNull();
  });

  it('does not fire on a large document that is NOT fragmented', () => {
    const documentMap = Array.from({ length: 40 }, () => section(15));
    expect(computeDeterministicCaveat(40, 3, documentMap)).toBeNull();
  });
});

describe('DocumentOverviewService.generate', () => {
  it('returns a synopsis with the deterministic caveat attached', async () => {
    const chat = jest.fn().mockResolvedValue({ content: 'This document specifies interface requirements for a backplane.' });
    const service = new DocumentOverviewService({ chat } as any);

    const documentMap = Array.from({ length: 6 }, () => section(10));
    const result = await service.generate({ documentMap, sectionCount: 6, depth: 2 });

    expect(result).toEqual({
      synopsis: 'This document specifies interface requirements for a backplane.',
      caveat: null,
    });
    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ seed: 42 }),
    );
  });

  it('fails open to null when the LLM call throws', async () => {
    const chat = jest.fn().mockRejectedValue(new Error('backend unreachable'));
    const service = new DocumentOverviewService({ chat } as any);

    const result = await service.generate({ documentMap: [section(10)], sectionCount: 1, depth: 1 });

    expect(result).toBeNull();
  });

  it('fails open to null when the LLM returns empty content', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '   ' });
    const service = new DocumentOverviewService({ chat } as any);

    const result = await service.generate({ documentMap: [section(10)], sectionCount: 1, depth: 1 });

    expect(result).toBeNull();
  });
});
