// Pure copy rules for how much of the user's knowledge base a run could use
// versus surfaced. "Surfaced", not "grounded" at job level: files_cited counts
// every retrieved file, including ones the relevance check judged unrelated
// (review report X12).

export interface KbCoverage {
  filesAvailable: number;
  filesCited: number;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

// Per-step note (live narration). Null when ingestion did not report how many
// files were available (older backend, or no KB retrieval) -- callers then
// keep their pre-coverage wording.
export function describeStepKbGrounding(
  available: number | null | undefined,
  cited: number,
  // The event's own kbGrounded flag: the note must agree with what the step
  // actually did, never contradict it.
  grounded: boolean,
): { grounded: boolean; text: string } | null {
  if (available == null) return null;
  if (grounded && cited > 0) {
    // Citations from an empty KB cannot happen; fall back to the legacy copy
    // rather than print "N of 0".
    if (available === 0) return null;
    return { grounded: true, text: `Grounded against ${cited} of ${available} KB ${plural(available, 'file', 'files')}` };
  }
  if (available === 0) return { grounded: false, text: 'Your knowledge base has no ingested files' };
  return {
    grounded: false,
    text: `Not grounded against your knowledge base for this step (${available} ${plural(available, 'file', 'files')} available)`,
  };
}

// Whole-job note for results. Null for BASELINE and jobs created before
// kbCoverage existed.
export function describeJobKbCoverage(
  coverage: KbCoverage | null | undefined,
): { tone: 'ok' | 'warning' | 'none'; text: string } | null {
  if (!coverage) return null;
  const { filesAvailable, filesCited } = coverage;
  if (filesAvailable === 0) return { tone: 'none', text: 'No knowledge-base files were available to this job.' };
  if (filesCited === 0) {
    return { tone: 'warning', text:
        filesAvailable === 1
          ? 'The 1 knowledge-base file was not surfaced for this job.'
          : `None of the ${filesAvailable} knowledge-base files were surfaced for this job.`, };
  }
  return {
    tone: 'ok',
    text: `${filesCited} of ${filesAvailable} knowledge-base ${plural(filesAvailable, 'file was', 'files were')} surfaced for this job.`,
  };
}
