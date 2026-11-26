import { kbFileStatus } from '../src/modules/kb/kb-file-types';
import { KbService } from '../src/modules/kb/kb.service';

// Owner finding (2026-11-26): files the folder tree cannot reach (recorded before their SharePoint library was, or of a type req2ado no longer
// reads) stayed in the knowledge base and kept grounding scoring. The list labels them so the page can offer to remove them.
describe('kbFileStatus', () => {
  it.each([
    ['spec.pdf', 'drive-1', 'current'],
    ['Deck.PPTX', 'drive-1', 'current'],
    ['notes.md', null, 'legacy'],
    ['archive.zip', 'drive-1', 'unsupported'],
    ['old.vsdx', null, 'unsupported'],
    ['no-extension', 'drive-1', 'unsupported'],
    ['Sub/folder/plan.docx', 'drive-1', 'current'],
  ])('labels %s (library %s) as %s', (name, driveId, status) => {
    expect(kbFileStatus({ name, driveId })).toBe(status);
  });
});

describe('KbService.listDocuments', () => {
  it('labels every document with its status', async () => {
    const rows = [
      { id: 'a', name: 'spec.pdf', driveId: 'drive-1' },
      { id: 'b', name: 'old.docx', driveId: null },
      { id: 'c', name: 'bundle.zip', driveId: 'drive-1' },
    ];
    const prisma = { ingestedDocument: { findMany: jest.fn().mockResolvedValue(rows) } };
    const service = new KbService(prisma as never, {} as never, {} as never);
    const listed = await service.listDocuments('u1');
    expect(listed.map((d) => [d.id, d.status])).toEqual([
      ['a', 'current'],
      ['b', 'legacy'],
      ['c', 'unsupported'],
    ]);
  });
});
