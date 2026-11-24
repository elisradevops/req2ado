import type { DryRunDiffEntry } from '../components/DiffTree';
import { GROUP_META, GROUP_ORDER, kindMeta, warningGroup, warningRecordText } from './warningKinds';
import { normalizeWarning, type WarningRecord } from './warnings';

export interface JobReportInput {
  jobId: string;
  fileName: string | null;
  mode: string | null;
  status: string | null;
  createdAt: string | null;
  project: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  workItemState: string | null;
  items: DryRunDiffEntry[];
  warnings: (WarningRecord | string)[];
  /** "How this run went": the run's own notices, already in words (liveCopy.noticeCopy), as the job page shows them. */
  runNotices?: { title: string; detail: string }[];
  /** When the report was made (ISO); injected so the report is reproducible in tests. */
  generatedAt: string;
}

const LADDER = ['Epic', 'Feature', 'Requirement'];
const ACTION_LABEL: Record<string, string> = { create: 'New', reuse: 'Reused (already in Azure DevOps)', dedup_skip: 'Skipped as a duplicate' };

/**
 * A job's report, readable by a person: what was run, what it proposes (per type, per action, per section), what the document's structure
 * left out, and what needs attention, in plain language. Markdown, so it reads in any editor and renders in a wiki or a pull request.
 * Built only from the job's own record: every number is counted from its items and warnings, nothing is estimated.
 */
export function jobReport(input: JobReportInput): string {
  const items = input.items;
  const excluded = excludedIds(items);
  const kept = items.filter((item) => !excluded.has(item.localId));
  const warnings = input.warnings.map(normalizeWarning);
  const lines: string[] = [];

  lines.push(`# Job report: ${input.fileName ?? input.jobId}`, '');
  lines.push('| | |', '|---|---|');
  lines.push(...row('File', input.fileName), ...row('Mode', input.mode?.toUpperCase() ?? null), ...row('Status', humanStatus(input.status)));
  lines.push(...row('Started', input.createdAt ? formatDate(input.createdAt) : null));
  lines.push(...row('Destination', destination(input.project, input.areaPath)));
  lines.push(...row('Iteration', input.iterationPath), ...row('Work item state', input.workItemState));
  lines.push(...row('Job id', input.jobId), ...row('Report made', formatDate(input.generatedAt)));
  lines.push('');

  // --- Items ------------------------------------------------------------------------------------------------------------------------
  lines.push('## Items', '');
  if (items.length === 0) {
    lines.push('The job has no proposed items.', '');
  } else {
    const byType = countBy(kept, (item) => item.type);
    const types = [...LADDER.filter((t) => byType.has(t)), ...[...byType.keys()].filter((t) => !LADDER.includes(t))];
    lines.push('| Type | Items |', '|---|---:|', ...types.map((type) => `| ${type} | ${byType.get(type)} |`), `| **Total** | **${kept.length}** |`, '');
    const byAction = countBy(kept, (item) => item.action);
    lines.push(
      ...[...byAction.entries()].map(([action, count]) => `- ${ACTION_LABEL[action] ?? action}: ${count}`),
      `- Requirements with a Customer ID: ${kept.filter((i) => i.type === 'Requirement' && i.customerId).length} of ${byType.get('Requirement') ?? 0}`,
    );
    if (excluded.size > 0) lines.push(`- Left out by the reviewer: ${excluded.size} (not written; not counted above)`);
    lines.push('');
    lines.push(...sectionTable(kept, warnings));
  }

  // --- What the structure left out --------------------------------------------------------------------------------------------------
  const leftOut = warnings.find((w) => w.kind === 'front_matter_left_out');
  const context = warnings.find((w) => w.kind === 'informational_section_folded');
  if (leftOut || context) {
    lines.push('## What the document\'s structure left out', '');
    const parts = (leftOut?.detail.parts as { text?: string; page?: number | null }[] | undefined) ?? [];
    if (parts.length > 0) {
      lines.push('Front matter, not made into items:', '', ...parts.map((part) => `- ${part.text ?? '(untitled)'}${part.page ? ` (page ${part.page})` : ''}`), '');
    }
    const sections = (context?.detail.sections as string[] | undefined) ?? [];
    if (sections.length > 0) {
      lines.push('Descriptive sections kept as context in their parent item, not made Requirements:', '', ...sections.map((s) => `- ${s}`), '');
    }
  }

  // --- How this run went -------------------------------------------------------------------------------------------------------------
  if (input.runNotices && input.runNotices.length > 0) {
    lines.push('## How this run went', '', ...input.runNotices.map((notice) => `- **${notice.title}.** ${oneLine(notice.detail)}`), '');
  }

  // --- Needs attention --------------------------------------------------------------------------------------------------------------
  lines.push('## Notices', '');
  if (warnings.length === 0) {
    lines.push('None.', '');
  } else {
    for (const group of GROUP_ORDER) {
      const inGroup = warnings.filter((w) => warningGroup(w) === group);
      if (inGroup.length === 0) continue;
      lines.push(`### ${GROUP_META[group].title} (${inGroup.length})`, '');
      for (const [kind, records] of groupBy(inGroup, (w) => w.kind)) {
        const meta = kindMeta(kind, records[0].severity);
        const affected = new Set(records.flatMap((r) => r.nodeIds)).size;
        lines.push(`**${meta.title}**${affected > 0 ? ` (${affected} ${affected === 1 ? 'item' : 'items'})` : records.length > 1 ? ` (${records.length})` : ''}`, '');
        lines.push(`${meta.short} ${meta.means}`.trim(), '');
        if (group !== 'info') lines.push(`What to do: ${meta.todo}`, '');
        for (const record of records.slice(0, 5)) lines.push(`- ${oneLine(warningRecordText(record))}`);
        if (records.length > 5) lines.push(`- … and ${records.length - 5} more`);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function sectionTable(items: DryRunDiffEntry[], warnings: WarningRecord[]): string[] {
  const byId = new Map(items.map((item) => [item.localId, item]));
  const flagged = new Set(warnings.filter((w) => warningGroup(w) !== 'info').flatMap((w) => w.nodeIds));
  const rows = new Map<string, { requirements: number; withId: number; flagged: number }>();
  for (const item of items) {
    if (item.type !== 'Requirement') continue;
    const parent = item.parentLocalId ? byId.get(item.parentLocalId) : undefined;
    const section = parent?.title ?? '(no section)';
    const entry = rows.get(section) ?? { requirements: 0, withId: 0, flagged: 0 };
    entry.requirements += 1;
    if (item.customerId) entry.withId += 1;
    if (flagged.has(item.localId)) entry.flagged += 1;
    rows.set(section, entry);
  }
  if (rows.size === 0) return [];
  return [
    '### Requirements by section',
    '',
    '| Section | Requirements | With Customer ID | Flagged |',
    '|---|---:|---:|---:|',
    ...[...rows.entries()].map(([section, r]) => `| ${escapeCell(section)} | ${r.requirements} | ${r.withId} | ${r.flagged} |`),
    '',
  ];
}

/** Items the reviewer left out, with everything under them (the write skips a whole excluded subtree). */
function excludedIds(items: DryRunDiffEntry[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) if (item.parentLocalId) children.set(item.parentLocalId, [...(children.get(item.parentLocalId) ?? []), item.localId]);
  const out = new Set<string>();
  const stack = items.filter((item) => item.excluded).map((item) => item.localId);
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/** Where the items go: the area path, which already starts with its project; the project only when the path does not name it. */
function destination(project: string | null, areaPath: string | null): string | null {
  if (!areaPath) return project;
  if (!project || areaPath === project || areaPath.startsWith(`${project}\\`)) return areaPath;
  return `${project} \\ ${areaPath}`;
}

function row(label: string, value: string | null): string[] {
  return value ? [`| ${label} | ${escapeCell(value)} |`] : [];
}

function countBy<T>(values: T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function humanStatus(status: string | null): string | null {
  if (!status) return null;
  return ({ diff_ready: 'Ready for review', written: 'Written to Azure DevOps', running: 'Running', failed: 'Failed', cancelled: 'Cancelled' } as Record<string, string>)[status] ?? status.replace(/_/g, ' ');
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}
