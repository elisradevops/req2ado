/**
 * Builds a deep link to a work item's edit page.
 *
 * `project` is included when known -- confirmed live: the org-only form
 * (`${orgUrl}/_workitems/edit/{id}`, relying on ADO's own global id-to-
 * project redirect) can resolve against the wrong project context in a
 * browser session, producing a misleading "does not exist, or you do not
 * have permission" error for a work item that actually exists. `project` is
 * the first `\`-delimited segment of a job's areaPath, already computed by
 * every caller that has one -- omitted (null/undefined) falls back to the
 * org-only form, same as before this helper existed.
 */
export function buildWorkItemUrl(orgUrl: string, project: string | null | undefined, id: number): string {
  if (!project) return `${orgUrl}/_workitems/edit/${id}`;
  return `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}
