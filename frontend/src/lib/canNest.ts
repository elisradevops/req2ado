// Reparent/reorder/add-item hierarchy tier rule -- mirrors ingestion's own
// id_hierarchy tier rule + root_regrouping.py's repair logic exactly: a node
// either advances one tier from its parent's category or repeats it; it
// never skips a tier or moves backward.
//
// `entry.type` on a DryRunDiffEntry is ALREADY the internal category label
// ('Epic' | 'Feature' | 'Requirement'), not the project's resolved ADO type
// name -- see jobs.service.ts's confirm()-time realType() comment ("entry.type
// itself stays the internal category label everywhere else ... translation
// only matters at the ADO wire boundary"). So this is a pure, local, 3-value
// function with no network dependency and no per-project resolution step.
//
// DUPLICATED, not imported, from orchestrator/src/modules/pipeline/canNest.ts
// -- frontend and orchestrator are separate deployables and frontend has no
// dependency on @req2ado/shared-ts today (that workspace package ships
// untranspiled .ts with no build step, and only orchestrator consumes it, as
// a devDependency, via type-only imports). Making this a real cross-package
// runtime import would require adding the dependency to frontend, widening
// its Docker build context to the repo root, and giving shared/ts an actual
// build step -- five build-infrastructure changes for a ~10-line pure
// function. See canNest.test.ts for the mechanical drift guard that keeps
// the two copies byte-identical instead.
export type NestingCategory = 'Epic' | 'Feature' | 'Requirement';

export function canNest(childCategory: string, parentCategory: string): boolean {
  if (parentCategory === 'Epic') return childCategory === 'Epic' || childCategory === 'Feature';
  if (parentCategory === 'Feature') return childCategory === 'Feature' || childCategory === 'Requirement';
  if (parentCategory === 'Requirement') return childCategory === 'Requirement';
  return false;
}

// A node may sit at the top level (no parent) only if it is the top category,
// or -- mirroring root_regrouping.py's own fallback -- a Feature when the
// document has no Epic at all.
export function canBeRoot(category: string, anyEpicExists: boolean): boolean {
  if (category === 'Epic') return true;
  if (category === 'Feature') return !anyEpicExists;
  return false;
}
