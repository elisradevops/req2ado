/**
 * Seed catalog used when the live ADO workitemrelationtypes call fails.
 * Real catalogs are always preferred — this is only the fallback, and only
 * covers built-in/common types; project-custom types beyond these are
 * visible only via the live call.
 */
export interface AdoLinkType {
  referenceName: string;
  name: string;
  semanticHint?: string;
}

export const SEED_LINK_TYPES: AdoLinkType[] = [
  {
    referenceName: 'System.LinkTypes.Hierarchy-Forward',
    name: 'Child',
    semanticHint: 'parent→child link; source is the parent, target is the child',
  },
  {
    referenceName: 'System.LinkTypes.Hierarchy-Reverse',
    name: 'Parent',
    semanticHint: 'child→parent link; source is the child, target is the parent',
  },
  {
    referenceName: 'System.LinkTypes.Related',
    name: 'Related',
    semanticHint: 'generic association between two work items',
  },
  {
    referenceName: 'System.LinkTypes.Affects-Forward',
    name: 'Affects',
    semanticHint: 'source item affects the target item',
  },
  {
    referenceName: 'System.LinkTypes.Affects-Reverse',
    name: 'Affected By',
    semanticHint: 'source item is affected by the target item',
  },
  {
    referenceName: 'Microsoft.VSTS.Common.TestedBy-Forward',
    name: 'Tested By',
    semanticHint: 'source item is tested by the target (test case)',
  },
  {
    referenceName: 'Microsoft.VSTS.Common.TestedBy-Reverse',
    name: 'Tests',
    semanticHint: 'source (test case) tests the target item',
  },
];

/** Relation types that do not link to another work item — never useful as a trace link. */
export const NON_WORK_ITEM_RELATION_TYPES: ReadonlySet<string> = new Set([
  'ArtifactLink',
  'Hyperlink',
  'AttachedFile',
]);

export function isWorkItemRelationType(referenceName: string): boolean {
  return !NON_WORK_ITEM_RELATION_TYPES.has(referenceName);
}
