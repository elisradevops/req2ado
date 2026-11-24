import { describe, expect, it } from 'vitest';
import type { DryRunDiffEntry } from '../components/DiffTree';
import { jobReport, type JobReportInput } from './jobReport';

const item = (localId: string, parentLocalId: string | null, type: string, title: string, over: Partial<DryRunDiffEntry> = {}): DryRunDiffEntry =>
  ({ localId, parentLocalId, type, title, description: '', action: 'create', customerId: null, ...over }) as DryRunDiffEntry;

const base: JobReportInput = {
  jobId: 'job-1',
  fileName: 'spec.pdf',
  mode: 'survey',
  status: 'diff_ready',
  createdAt: '2026-11-24T09:52:08Z',
  project: 'Project',
  areaPath: 'Project\\Customer Requirements',
  iterationPath: null,
  workItemState: null,
  generatedAt: '2026-11-24T15:00:00Z',
  items: [
    item('e1', null, 'Epic', 'Coffee Unit Specification'),
    item('f1', 'e1', 'Feature', '3 Operation'),
    item('f11', 'f1', 'Feature', '3.2 Brewing'),
    item('r1', 'f11', 'Requirement', 'The unit shall heat water.', { customerId: 'CFM-014' }),
    item('r2', 'f11', 'Requirement', 'The unit shall pour.', { action: 'reuse' }),
    item('r3', 'f11', 'Requirement', 'Old wording.', { excluded: true }),
  ],
  warnings: [
    {
      kind: 'front_matter_left_out',
      severity: 'auto_fixed',
      nodeIds: [],
      raw: 'Left out as front matter ...',
      detail: { parts: [{ text: 'Revision History', page: 2 }, { text: 'Table of Contents', page: 2 }] },
    },
    { kind: 'informational_section_folded', severity: 'auto_fixed', nodeIds: ['f1'], raw: 'Kept as context ...', detail: { sections: ['1.1 Scope'] } },
    { kind: 'missing_source_reference', severity: 'needs_review', nodeIds: ['r2'], raw: 'engineer text', detail: {} },
  ],
};

describe('jobReport', () => {
  const report = jobReport(base);

  it('states what was run, in words', () => {
    expect(report).toContain('# Job report: spec.pdf');
    expect(report).toContain('| Mode | SURVEY |');
    expect(report).toContain('| Status | Ready for review |');
    expect(report).toContain('| Destination | Project\\Customer Requirements |'); // the area path already names its project
    expect(report).toContain('| Started | 2026-11-24 09:52 UTC |');
    expect(report).not.toContain('Iteration'); // absent, not blank
  });

  it('counts the items per type and per action, leaving out what the reviewer excluded', () => {
    expect(report).toContain('| Requirement | 2 |');
    expect(report).toContain('| **Total** | **5** |');
    expect(report).toContain('- New: 4');
    expect(report).toContain('- Reused (already in Azure DevOps): 1');
    expect(report).toContain('- Requirements with a Customer ID: 1 of 2');
    expect(report).toContain('- Left out by the reviewer: 1');
  });

  it('lists the requirements by section, with Customer IDs and flags', () => {
    expect(report).toContain('| 3.2 Brewing | 2 | 1 | 1 |');
  });

  it('says what the document structure left out, by the document\'s own headings and pages', () => {
    expect(report).toContain('- Revision History (page 2)');
    expect(report).toContain('- 1.1 Scope');
  });

  it('explains each notice in plain language, grouped by what to do about it', () => {
    expect(report).toMatch(/### Fix before writing \(1\)/); // a missing Customer ID is fixed (or accepted) before the write
    expect(report).toContain('1 requirement has no Customer ID. None was invented.');
    expect(report).toContain('What to do:');
    expect(report).not.toContain('"kind"'); // no raw records
  });

  it('includes "How this run went", in the words the job page uses', () => {
    const withRun = jobReport({ ...base, runNotices: [{ title: 'The model server was busy', detail: 'The request was sent again.' }] });
    expect(withRun).toContain('## How this run went');
    expect(withRun).toContain('- **The model server was busy.** The request was sent again.');
    expect(report).not.toContain('## How this run went'); // no notices, no section
  });

  it('says so plainly when a job has no items', () => {
    expect(jobReport({ ...base, items: [], warnings: [] })).toContain('The job has no proposed items.');
  });
});
