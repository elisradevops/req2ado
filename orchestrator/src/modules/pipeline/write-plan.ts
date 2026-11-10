// The rules for what a write to Azure DevOps will do, in one place. JobsService.confirm() calls the select* functions below to decide what it
// creates, links and trace-links; buildWritePreview() calls the same functions on a simulated id map, so the pre-write summary shown to the
// reviewer cannot drift from the real write. Pure: no I/O, no ADO calls.

import type { WritePreview } from '@req2ado/shared-ts';
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
  // Figures cited by this entry, attached to its work item after the write.
  figureIds?: string[];
  // Figures without a caption, and the subset of them judged decorative. Uncaptioned figures that are not insignificant are attached too.
  uncaptionedFigureIds?: string[];
  insignificantFigureIds?: string[];
  // Figures the reviewer chose not to attach to this entry. They stay in the lists above (so the choice is undoable and the manual attach route still
  // finds them) but are never attached automatically.
  detachedFigureIds?: string[];
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
  // One Set for the whole pass, so a large selection is not rescanned per entry. `undefined` means no selection (everything); `[]` means nothing.
  const selected = options.selectedLocalIds === undefined ? undefined : new Set(options.selectedLocalIds);
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    // 'dedup_skip' is skipped the same as 'reuse': both already have a real ADO id to point at, just with different certainty (exact-hash
    // fact versus embedding-similarity judgment). Neither triggers a create.
    if ((entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null) {
      resolvedAdoIdByLocalId.set(entry.localId, entry.existingAdoId);
      continue;
    }
    // A deselected 'create' row is dropped here. It never gets an id, so a child of it is not linked.
    if (selected !== undefined && !selected.has(entry.localId)) continue;
    // Resume: created by a prior attempt at this same job.
    if (options.resumedAdoIdByLocalId.has(entry.localId)) continue;
    toCreate.push(entry);
  }
  return { toCreate, resolvedAdoIdByLocalId };
}

// Selected ids that are not in the diff at all (a stale or mistyped selection), in the order given.
export function findUnknownSelections<T extends WritePlanEntry>(diff: T[], selectedLocalIds: string[]): string[] {
  const known = new Set(diff.map((entry) => entry.localId));
  return selectedLocalIds.filter((localId) => !known.has(localId));
}

// Selected 'create' entries whose parent is a 'create' entry that this write would leave out: deselected, not excluded and not written by an
// earlier attempt. Such a child would be created with no parent link. A parent that is reuse/dedup_skip (already has an id), already mapped or
// excluded (the child is then excluded too) is not a problem. Same create-versus-resolved test as selectEntriesToCreate.
export function findOrphanedSelections<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  options: { resumedAdoIdByLocalId: Map<string, number>; selectedLocalIds: string[] },
): string[] {
  const selected = new Set(options.selectedLocalIds);
  const entryByLocalId = new Map(diff.map((entry) => [entry.localId, entry] as const));
  const resolvesToExisting = (entry: T) => (entry.action === 'reuse' || entry.action === 'dedup_skip') && entry.existingAdoId !== null;
  const orphans: string[] = [];
  for (const entry of diff) {
    if (isExcluded(entry) || resolvesToExisting(entry) || !selected.has(entry.localId) || entry.parentLocalId === null) continue;
    const parent = entryByLocalId.get(entry.parentLocalId);
    if (!parent || isExcluded(parent) || resolvesToExisting(parent)) continue;
    if (selected.has(parent.localId) || options.resumedAdoIdByLocalId.has(parent.localId)) continue;
    orphans.push(entry.localId);
  }
  return orphans;
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

// Trace links to write (grouped by the source work item's ADO id), and how many were declared on non-excluded entries. A link whose source or
// target has no ADO id is left out of the plan, so declared minus planned is the number skipped.
export function traceLinkTally<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  adoIdByLocalId: Map<string, number>,
): { bySource: Map<number, PlannedTraceLink[]>; planned: number; declared: number } {
  const bySource = new Map<number, PlannedTraceLink[]>();
  let planned = 0;
  let declared = 0;
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    for (const link of entry.traceLinks ?? []) {
      declared += 1;
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
      planned += 1;
    }
  }
  return { bySource, planned, declared };
}

// Trace links to write, grouped by the source work item's ADO id. A link whose source or target has no ADO id is left out here.
export function selectTraceLinks<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  adoIdByLocalId: Map<string, number>,
): Map<number, PlannedTraceLink[]> {
  return traceLinkTally(diff, isExcluded, adoIdByLocalId).bySource;
}

// Figure ids an entry would attach: captioned ones plus uncaptioned ones not judged insignificant, minus the ones the reviewer detached, without duplicates.
export function attachableFigureIds(entry: WritePlanEntry): string[] {
  const insignificant = new Set(entry.insignificantFigureIds ?? []);
  const detached = new Set(entry.detachedFigureIds ?? []);
  return [
    ...new Set([
      ...(entry.figureIds ?? []),
      ...(entry.uncaptionedFigureIds ?? []).filter((figureId) => !insignificant.has(figureId)),
    ]),
  ].filter((figureId) => !detached.has(figureId));
}

// Figures to attach, grouped by ADO work item id: every figure (captioned, or uncaptioned and not judged insignificant) of a non-excluded entry this job creates or resumes and whose file
// is still stored (`storedFigureIds`; a file is deleted once uploaded, so a retry only picks up what is left). A Set per work item, because two
// entries can resolve to the same id and one work item must not get the same figure twice.
// `eligibleAdoIdByLocalId` holds ONLY created and resumed entries: a reuse/dedup_skip entry (its id comes from resolvedAdoIdByLocalId) is an existing item
// that only matched by similarity, and re-importing a document must not re-attach identical figures to it. The manual attach route is separate.
export function selectFiguresToAttach<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  eligibleAdoIdByLocalId: Map<string, number>,
  storedFigureIds: { has(figureId: string): boolean },
): Map<number, Set<string>> {
  const toAttachByAdoId = new Map<number, Set<string>>();
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    const adoId = eligibleAdoIdByLocalId.get(entry.localId);
    if (adoId === undefined) continue;
    for (const figureId of attachableFigureIds(entry)) {
      if (storedFigureIds.has(figureId)) {
        const set = toAttachByAdoId.get(adoId) ?? new Set<string>();
        set.add(figureId);
        toAttachByAdoId.set(adoId, set);
      }
    }
  }
  return toAttachByAdoId;
}

// Entries the reviewer excluded directly, and entries dropped only because an ancestor was excluded.
export function countExclusions<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
): { direct: number; viaAncestor: number } {
  let direct = 0;
  let viaAncestor = 0;
  for (const entry of diff) {
    if (entry.excluded) direct += 1;
    else if (isExcluded(entry)) viaAncestor += 1;
  }
  return { direct, viaAncestor };
}

// Distinct existing parents (resolved to an ADO id by this job's reuse/dedup_skip) of entries that get a new parent link. A resumed-only parent
// is not in resolvedAdoIdByLocalId, so it is not counted. An entry is "existing" only if it resolved to a real ADO id.
export function existingParentsGettingChildren<T extends WritePlanEntry>(
  linked: T[],
  resolvedAdoIdByLocalId: Map<string, number>,
): number {
  const existingParents = new Set<string>();
  for (const entry of linked) {
    if (resolvedAdoIdByLocalId.has(entry.parentLocalId as string)) existingParents.add(entry.parentLocalId as string);
  }
  return existingParents.size;
}

// Non-excluded entries that resolved to an existing ADO id AND have a parent. A root existing entry is not counted.
export function existingWithoutNewParentLink<T extends WritePlanEntry>(
  diff: T[],
  isExcluded: (entry: T) => boolean,
  resolvedAdoIdByLocalId: Map<string, number>,
): number {
  let count = 0;
  for (const entry of diff) {
    if (isExcluded(entry)) continue;
    if (resolvedAdoIdByLocalId.has(entry.localId) && entry.parentLocalId !== null) count += 1;
  }
  return count;
}

// The wire contract lives in shared/schemas/write-preview.schema.json (generated into @req2ado/shared-ts); this file computes it.
export type { WritePreview };

export interface WritePreviewResume {
  resumedAdoIdByLocalId: Map<string, number>;
  alreadyLinkedLocalIds: Set<string>;
  // Figure ids whose file is still stored for the job. Omitted means none, so figuresToAttach is 0.
  pendingFigureIds?: Set<string>;
}

// Whether a write would do anything at all: create, link, trace-link or attach.
export function planHasWork(preview: Omit<WritePreview, 'hasWork' | 'figuresOnly'>): boolean {
  return preview.createdTotal > 0 || preview.parentLinks > 0 || preview.traceLinks.planned > 0 || preview.figuresToAttach > 0;
}

// Only figures are left: nothing is created and no link is added, but figures are still attached to their items.
export function planIsFiguresOnly(preview: Omit<WritePreview, 'hasWork' | 'figuresOnly'>): boolean {
  return preview.createdTotal === 0 && preview.parentLinks === 0 && preview.traceLinks.planned === 0 && preview.figuresToAttach > 0;
}

// What a write would do for this diff right now. Created ids are simulated (any number), because the rules only ask whether an id exists.
export function buildWritePreview<T extends WritePlanEntry>(
  diff: T[],
  resume: WritePreviewResume = { resumedAdoIdByLocalId: new Map(), alreadyLinkedLocalIds: new Set() },
  selectedLocalIds?: string[],
): WritePreview {
  const isExcluded = buildExclusionChecker(diff);
  const { toCreate, resolvedAdoIdByLocalId } = selectEntriesToCreate(diff, isExcluded, {
    resumedAdoIdByLocalId: resume.resumedAdoIdByLocalId,
    selectedLocalIds,
  });

  // Each created item gets its own simulated (negative) id, so items that are not yet written never share a work item in the figure grouping.
  const adoIdByLocalId = new Map<string, number>(resume.resumedAdoIdByLocalId);
  for (const [localId, adoId] of resolvedAdoIdByLocalId) adoIdByLocalId.set(localId, adoId);
  toCreate.forEach((entry, index) => adoIdByLocalId.set(entry.localId, -(index + 1)));

  const createdByType: Record<string, number> = {};
  for (const entry of toCreate) createdByType[entry.type] = (createdByType[entry.type] ?? 0) + 1;

  const links = selectEntriesToLink(diff, isExcluded, adoIdByLocalId, resume.alreadyLinkedLocalIds);
  const { planned, declared } = traceLinkTally(diff, isExcluded, adoIdByLocalId);

  let alreadyWritten = 0;
  for (const entry of diff) {
    if (!isExcluded(entry) && resume.resumedAdoIdByLocalId.has(entry.localId)) alreadyWritten += 1;
  }
  let figuresToAttach = 0;
  // Same eligibility as confirm(): created (simulated ids) and resumed entries only, never the resolved reuse/dedup_skip ones.
  const figureEligibleIds = new Map<string, number>(resume.resumedAdoIdByLocalId);
  toCreate.forEach((entry, index) => figureEligibleIds.set(entry.localId, -(index + 1)));
  const figuresByAdoId = selectFiguresToAttach(diff, isExcluded, figureEligibleIds, resume.pendingFigureIds ?? new Set<string>());
  for (const set of figuresByAdoId.values()) figuresToAttach += set.size;
  // Only created entries: nothing is uploaded for them yet, so a missing row means unavailable. Resumed rows are deleted after upload.
  let figuresUnavailable = 0;
  if (resume.pendingFigureIds) {
    for (const entry of toCreate) {
      for (const figureId of attachableFigureIds(entry)) if (!resume.pendingFigureIds.has(figureId)) figuresUnavailable += 1;
    }
  }

  const counts = {
    createdTotal: toCreate.length,
    createdLocalIds: toCreate.map((entry) => entry.localId),
    createdByType,
    excluded: countExclusions(diff, isExcluded),
    parentLinks: links.length,
    existingGettingChildren: existingParentsGettingChildren(links, resolvedAdoIdByLocalId),
    existingWithoutNewParentLink: existingWithoutNewParentLink(diff, isExcluded, resolvedAdoIdByLocalId),
    traceLinks: { planned, skipped: declared - planned },
    alreadyWritten,
    figuresToAttach,
    figuresUnavailable,
  };
  return { ...counts, hasWork: planHasWork(counts), figuresOnly: planIsFiguresOnly(counts) };
}
