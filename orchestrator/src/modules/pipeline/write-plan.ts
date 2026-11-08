// The rules for what a write to Azure DevOps will do, in one place. JobsService.confirm() calls the select* functions below to decide what it
// creates, links and trace-links; buildWritePreview() calls the same functions on a simulated id map, so the pre-write summary shown to the
// reviewer cannot drift from the real write. Pure: no I/O, no ADO calls.

import { buildExclusionChecker, type DiffEntryForExclusion } from './diff-summary';

export interface WritePlanTraceLink {
  sourceLocalId: string;
  referenceName: string;
  targetKind: 'intraJob' | 'crossJob';
  targetLocalId?: string;
  targetCustomerId?: string;
  resolvedAdoId?: number;
  resolutionStatus: 'resolved' | 'unresolved' | 'pending';
}

export interface WritePlanEntry extends DiffEntryForExclusion {
  type: string;
  action: 'create' | 'reuse' | 'dedup_skip' | string;
  existingAdoId: number | null;
  traceLinks?: WritePlanTraceLink[];
}

export interface PlannedTraceLink {
  targetAdoId: number;
  referenceName: string;
  sourceLocalId: string;
}

// Split the diff into entries that need a real create and entries that already resolve to an ADO id (reuse and dedup_skip).
export function selectEntriesToCreate<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  options: { resumedAdoIdByLocalId: Map<string, number>; selectedLocalIds?: string[] },
): { toCreate: T[]; resolvedAdoIdByLocalId: Map<string, number> } {
  const toCreate: T[] = [];
  const resolvedAdoIdByLocalId = new Map<string, number>();
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    // 'dedup_skip' is skipped the same as 'reuse': both already have a real ADO id to point at, just with different certainty (exact-hash
    // fact versus embedding-similarity judgment). Neither triggers a create.
    if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
      resolvedAdoIdByLocalId.set(entry.localId, entry.existingAdoId);
      continue;
    }
    // A deselected 'create' row is dropped here. It never gets an id, so a child of it is not linked.
    if (options.selectedLocalIds !== undefined && !options.selectedLocalIds.includes(entry.localId)) continue;
    // Resume: created by a prior attempt at this same job.
    if (options.resumedAdoIdByLocalId.has(entry.localId)) continue;
    toCreate.push(entry);
  }
  return { toCreate, resolvedAdoIdByLocalId };
}

// Entries that get a new parent link. Only a new child of a known parent is linked.
export function selectEntriesToLink<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  adoIdByLocalId: Map<string, number>,
  alreadyLinkedLocalIds: Set<string>,
): T[] {
  return diff.filter((entry) => {
    if (entry.parentLocalId === null) return false;
    if (isExcluded(entry)) return false;
    // Never re-parent an existing ADO item. A dedup_skip match is a similarity guess, and a 'reuse' item already has its own parent: ADO allows
    // at most one Parent relation per item and a second `add` fails with TF401349 (confirmed live). A NEW child may link UP to either.
    if (entry.action === 'dedup_skip') return false;
    if (entry.action === 'reuse') return false;
    // Resume: this link already succeeded in a prior attempt.
    if (alreadyLinkedLocalIds.has(entry.localId)) return false;
    return adoIdByLocalId.has(entry.localId) && adoIdByLocalId.has(entry.parentLocalId as string);
  });
}

// Trace links to write, grouped by the source work item's ADO id. A link whose source or target has no ADO id is left out here.
export function selectTraceLinks<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  adoIdByLocalId: Map<string, number>,
): Map<number, PlannedTraceLink[]> {
  const bySource = new Map<number, PlannedTraceLink[]>();
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    for (const link of entry.traceLinks ?? []) {
      const sourceAdoId = adoIdByLocalId.get(link.sourceLocalId);
      if (sourceAdoId === undefined) continue;
      let targetAdoId: number | undefined;
      if (link.targetKind === 'intraJob' && link.targetLocalId) {
        targetAdoId = adoIdByLocalId.get(link.targetLocalId);
      } else if (link.targetKind === 'crossJob' && link.resolutionStatus === 'resolved') {
        targetAdoId = link.resolvedAdoId;
      }
      if (targetAdoId === undefined) continue;
      const list = bySource.get(sourceAdoId) ?? [];
      list.push({ targetAdoId, referenceName: link.referenceName, sourceLocalId: link.sourceLocalId });
      bySource.set(sourceAdoId, list);
    }
  }
  return bySource;
}

export interface WritePreview {
  createdTotal: number;
  // The local ids of the items that will be created, so a caller can relate its own per-item facts (such as how each was reviewed) to the write.
  createdLocalIds: string[];
  createdByType: Record<string, number>;
  // Entries the reviewer excluded, and entries dropped because an ancestor was excluded.
  excluded: { direct: number; viaAncestor: number };
  // New parent links that will be written.
  parentLinks: number;
  // Existing items (reuse or near-duplicate) that will receive new children, and existing items that get no new parent link.
  existingGettingChildren: number;
  existingWithoutNewParentLink: number;
  // Trace links: written, and declared but not written (target excluded, not created, or unresolved).
  traceLinks: { planned: number; skipped: number };
}

export interface WritePreviewResume {
  resumedAdoIdByLocalId: Map<string, number>;
  alreadyLinkedLocalIds: Set<string>;
}

// What a write would do for this diff right now. Created ids are simulated (any number), because the rules only ask whether an id exists.
export function buildWritePreview<T extends WritePlanEntry>(
  diff: T[],
  resume: WritePreviewResume = { resumedAdoIdByLocalId: new Map(), alreadyLinkedLocalIds: new Set() },
): WritePreview {
  const isExcluded = buildExclusionChecker(diff);
  const { toCreate, resolvedAdoIdByLocalId } = selectEntriesToCreate(diff, isExcluded, { resumedAdoIdByLocalId: resume.resumedAdoIdByLocalId });

  const adoIdByLocalId = new Map<string, number>(resume.resumedAdoIdByLocalId);
  for (const [localId, adoId] of resolvedAdoIdByLocalId) adoIdByLocalId.set(localId, adoId);
  for (const entry of toCreate) adoIdByLocalId.set(entry.localId, 0);

  const createdByType: Record<string, number> = {};
  for (const entry of toCreate) createdByType[entry.type] = (createdByType[entry.type] ?? 0) + 1;

  let direct = 0;
  let viaAncestor = 0;
  for (const entry of diff) {
    if (entry.excluded) direct += 1;
    else if (isExcluded(entry)) viaAncestor += 1;
  }

  const links = selectEntriesToLink(diff, isExcluded, adoIdByLocalId, resume.alreadyLinkedLocalIds);

  const existingParents = new Set<string>();
  let existingWithoutNewParentLink = 0;
  const diffById = new Map(diff.map((entry) => [entry.localId, entry] as const));
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    const isExisting = entry.action === 'reuse' || entry.action === 'dedup_skip';
    if (isExisting && entry.parentLocalId !== null) existingWithoutNewParentLink += 1;
    if (!isExisting && entry.parentLocalId !== null) {
      const parent = diffById.get(entry.parentLocalId);
      if (parent && (parent.action === 'reuse' || parent.action === 'dedup_skip')) existingParents.add(parent.localId);
    }
  }

  let declared = 0;
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    declared += (entry.traceLinks ?? []).length;
  }
  let planned = 0;
  for (const list of selectTraceLinks(diff, isExcluded, adoIdByLocalId).values()) planned += list.length;

  return {
    createdTotal: toCreate.length,
    createdLocalIds: toCreate.map((entry) => entry.localId),
    createdByType,
    excluded: { direct, viaAncestor },
    parentLinks: links.length,
    existingGettingChildren: existingParents.size,
    existingWithoutNewParentLink,
    traceLinks: { planned, skipped: declared - planned },
  };
}
