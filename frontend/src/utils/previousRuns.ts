// An earlier job of a file with the same name, so a re-upload of something already processed is said out loud before a second run is
// started. The name is all the job list carries, and the same name is not proof of the same file: the wording says "a file with this
// name", never "this file". One pass over the list.
export interface PreviousRunJob {
  id: string;
  originalFilename: string;
  createdAt: string;
  status: string;
}

export interface PreviousRuns {
  latest: PreviousRunJob;
  // How many more earlier jobs share the name.
  others: number;
}

export function findPreviousRuns(jobs: ReadonlyArray<PreviousRunJob> | undefined, fileName: string): PreviousRuns | null {
  const wanted = fileName.trim().toLowerCase();
  if (!jobs || wanted === '') return null;
  let latest: PreviousRunJob | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  let matches = 0;
  for (const job of jobs) {
    if (job.originalFilename.trim().toLowerCase() !== wanted) continue;
    matches += 1;
    const time = Date.parse(job.createdAt);
    // An unreadable date never wins, but the job still counts as a run of this file.
    const comparable = Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
    if (latest === null || comparable > latestTime) {
      latest = job;
      latestTime = comparable;
    }
  }
  return latest ? { latest, others: matches - 1 } : null;
}
