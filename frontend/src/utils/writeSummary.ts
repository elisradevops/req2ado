import type { WritePreview } from '../api/jobs';
import type { ApprovalBreakdown } from './approvalBreakdown';
import { warningGroup, type WarningGroup } from './warningKinds';
import type { WarningRecord } from './warnings';

// The words of the final write summary (P17d). The numbers come from the server's preview; this file only phrases them, so it holds no
// write rules. A line's tone is 'notice' when the reviewer should look twice before writing.
export interface SummaryLine {
  id: 'create' | 'excluded' | 'parent-links' | 'existing' | 'trace-links' | 'review';
  text: string;
  tone: 'plain' | 'notice';
}

const TYPE_ORDER = ['Epic', 'Feature', 'Requirement'];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function writeSummaryLines(preview: WritePreview, review: ApprovalBreakdown): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (preview.createdTotal === 0) {
    lines.push({ id: 'create', text: 'Nothing will be created.', tone: 'notice' });
  } else {
    const types = Object.keys(preview.createdByType).sort((a, b) => {
      const rank = (type: string) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    const parts = types.map((type) => plural(preview.createdByType[type], type));
    lines.push({ id: 'create', text: `${plural(preview.createdTotal, 'new work item')}: ${parts.join(', ')}.`, tone: 'plain' });
  }

  const excludedTotal = preview.excluded.direct + preview.excluded.viaAncestor;
  if (excludedTotal > 0) {
    const why = [
      preview.excluded.direct > 0 ? `${preview.excluded.direct.toLocaleString()} excluded by you` : null,
      preview.excluded.viaAncestor > 0 ? `${preview.excluded.viaAncestor.toLocaleString()} under an excluded parent` : null,
    ].filter((part): part is string => part !== null);
    lines.push({ id: 'excluded', text: `${plural(excludedTotal, 'item')} left out: ${why.join(', ')}.`, tone: 'plain' });
  }

  if (preview.parentLinks > 0) {
    lines.push({
      id: 'parent-links',
      text: `${plural(preview.parentLinks, 'parent link')} will be added.`,
      tone: 'plain',
    });
  }

  if (preview.existingGettingChildren > 0 || preview.existingWithoutNewParentLink > 0) {
    const sentences: string[] = [];
    if (preview.existingGettingChildren > 0) {
      sentences.push(`${plural(preview.existingGettingChildren, 'existing item')} will get new children.`);
    }
    if (preview.existingWithoutNewParentLink > 0) {
      sentences.push(
        `${plural(preview.existingWithoutNewParentLink, 'existing item')} keep${preview.existingWithoutNewParentLink === 1 ? 's' : ''} ` +
          `their current parent: no parent link is added to ${preview.existingWithoutNewParentLink === 1 ? 'it' : 'them'}.`,
      );
    }
    lines.push({ id: 'existing', text: sentences.join(' '), tone: 'notice' });
  }

  if (preview.traceLinks.planned > 0 || preview.traceLinks.skipped > 0) {
    const sentences: string[] = [];
    if (preview.traceLinks.planned > 0) sentences.push(`${plural(preview.traceLinks.planned, 'trace link')} will be added.`);
    if (preview.traceLinks.skipped > 0) {
      sentences.push(
        `${plural(preview.traceLinks.skipped, 'trace link')} will not be added because the linked item is excluded, not written or not resolved.`,
      );
    }
    lines.push({ id: 'trace-links', text: sentences.join(' '), tone: preview.traceLinks.skipped > 0 ? 'notice' : 'plain' });
  }

  if (preview.createdTotal > 0) {
    const parts = [
      review.edited > 0 ? `${review.edited.toLocaleString()} edited` : null,
      review.single > 0 ? `${review.single.toLocaleString()} approved one by one` : null,
      review.bulkSpotChecked > 0 ? `${review.bulkSpotChecked.toLocaleString()} approved in bulk after you looked at them` : null,
      review.bulk > 0 ? `${review.bulk.toLocaleString()} approved in bulk without being looked at` : null,
      review.earlier > 0 ? `${review.earlier.toLocaleString()} reviewed earlier` : null,
      review.notReviewed > 0 ? `${review.notReviewed.toLocaleString()} not reviewed` : null,
    ].filter((part): part is string => part !== null);
    // Only a summary of review that has happened, or an unreviewed gap, is worth a line.
    if (parts.length > 0) {
      lines.push({ id: 'review', text: `Review: ${parts.join(', ')}.`, tone: review.notReviewed > 0 || review.bulk > 0 ? 'notice' : 'plain' });
    }
  }
  return lines;
}

export interface WarningCounts {
  open: Record<WarningGroup, number>;
  handled: number;
}

// Warnings the reviewer has not marked handled, by group, and how many they marked handled. Advisory: the write never reads them.
export function countWarningsForWrite(warnings: WarningRecord[]): WarningCounts {
  const result: WarningCounts = { open: { fix: 0, review: 0, info: 0 }, handled: 0 };
  for (const warning of warnings) {
    if (warning.acknowledged) result.handled += 1;
    else result.open[warningGroup(warning)] += 1;
  }
  return result;
}
