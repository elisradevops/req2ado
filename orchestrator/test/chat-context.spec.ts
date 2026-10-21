import { buildChatContext } from '../src/modules/chat/chat-context';

const entry = (localId: string, parentLocalId: string | null, type: string, title: string, extra: Record<string, unknown> = {}) => ({
  localId,
  parentLocalId,
  type,
  title,
  description: `${title} description`,
  action: 'create',
  excluded: false,
  ...extra,
});

const diff = [
  entry('e1', null, 'Epic', 'RF front end'),
  entry('f1', 'e1', 'Feature', 'Carrier acquisition'),
  entry('r1', 'f1', 'Requirement', 'Receiver lock time', {
    traceLinks: [
      { sourceLocalId: 'r1', referenceName: 'System.LinkTypes.Related', displayName: 'Related', targetKind: 'intraJob', targetLocalId: 'r9', resolutionStatus: 'pending' },
      { sourceLocalId: 'r1', referenceName: 'System.LinkTypes.Related', displayName: 'Related', targetKind: 'crossJob', targetCustomerId: 'X-1', resolutionStatus: 'pending' },
    ],
    figureIds: ['fig-1'],
    tableIds: ['t1'],
  }),
  entry('r2', 'f1', 'Requirement', 'Loss of lock reporting'),
  entry('r3', 'f1', 'Requirement', 'Excluded sibling', { excluded: true }),
  entry('r4', 'f1', 'Requirement', 'Reused sibling', { action: 'reuse' }),
  entry('r9', 'e1', 'Requirement', 'Filter settling time'),
  entry('e2', null, 'Epic', 'Power'),
  entry('r8', 'e2', 'Requirement', 'Unrelated to this item'),
];
const job = {
  filename: 'AirPro.docx',
  figureDescriptions: [{ figureIndex: 1, figureId: 'fig-1', name: 'Lock state machine', caption: 'States from idle to locked.' }],
  tableDescriptions: [{ tableId: 't1', caption: 'Acquisition timing limits' }],
};

describe('buildChatContext', () => {
  const context = buildChatContext(diff as any, diff[2] as any, job as any);

  it('lists the parents root first, with their descriptions', () => {
    expect(context.parents).toEqual([
      { type: 'Epic', title: 'RF front end', description: 'RF front end description' },
      { type: 'Feature', title: 'Carrier acquisition', description: 'Carrier acquisition description' },
    ]);
  });

  it('lists the other items under the same parent, not excluded or reused ones, and nothing from other branches', () => {
    expect(context.siblings).toEqual([{ title: 'Loss of lock reporting' }]);
  });

  it('names the items it is linked to inside the job, with the relation, and ignores links that point outside the job', () => {
    expect(context.linked).toEqual([{ relation: 'Related', title: 'Filter settling time' }]);
  });

  it('carries the captions of its own figures and tables', () => {
    expect(context.figures).toEqual([{ name: 'Lock state machine', caption: 'States from idle to locked.' }]);
    expect(context.tables).toEqual([{ caption: 'Acquisition timing limits' }]);
  });

  it('names the document', () => {
    expect(context.documentName).toBe('AirPro.docx');
  });

  it('is bounded whatever the tree looks like, and survives a cycle in the parent links', () => {
    const many = [
      entry('p', null, 'Feature', 'P'),
      ...Array.from({ length: 200 }, (_, i) => entry(`s${i}`, 'p', 'Requirement', `Sibling ${i}`)),
    ];
    expect(buildChatContext(many as any, many[1] as any, {} as any).siblings!.length).toBeLessThanOrEqual(20);
    const cyclic = [entry('a', 'b', 'Epic', 'A'), entry('b', 'a', 'Feature', 'B'), entry('c', 'b', 'Requirement', 'C')];
    expect(buildChatContext(cyclic as any, cyclic[2] as any, {} as any).parents!.length).toBeLessThanOrEqual(5);
  });

  it('is empty-handed, not broken, for an item with nothing around it', () => {
    const alone = [entry('x', null, 'Requirement', 'Alone')];
    expect(buildChatContext(alone as any, alone[0] as any, {} as any)).toEqual({ parents: [], siblings: [], linked: [], figures: [], tables: [] });
  });
});
