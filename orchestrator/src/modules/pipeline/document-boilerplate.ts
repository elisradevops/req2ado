// Text that is part of a document's furniture, not a requirement: a disclaimer, a legal or confidentiality notice, a copyright line, a
// revision table or distribution list, a "mock data" banner. SURVEY drafts it as a Requirement like anything else, and it then tops the
// risk-first review queue with a quality score near zero. The detector is deliberately narrow, since a wrong answer costs a real
// requirement a reviewer might skip:
//   - only a Requirement that would be created;
//   - never a text that states an obligation (shall / must / is required to), however notice-like its heading;
//   - the notice wording has to START the title or the description, not merely appear in it;
//   - short only: a long text is more likely a real section.
// The caller excludes what this returns by default and says so in an Info warning. Nothing is deleted: Include puts an item back.

const MAX_TEXT_CHARS = 400;

const OBLIGATION = /\b(shall|must|is required to|are required to|will be required to)\b/i;

const NOTICE_START = [
  /^(mock|anonymi[sz]ed|sample|dummy|fictional|synthetic)\b.{0,40}\bdata\b/i,
  /^(legal\s+)?disclaimer\b/i,
  /^(legal|confidentiality|copyright|proprietary)\s+(notice|statement)\b/i,
  /^copyright\b/i,
  /^©/,
  /^all rights reserved\b/i,
  /^(proprietary|confidential)\b/i,
  /^this document (is|contains) (confidential|proprietary|the property of)\b/i,
  /^(revision|change|version) (history|log)\b/i,
  /^document (control|history)\b/i,
  /^distribution list\b/i,
];

interface BoilerplateCandidate {
  localId: string;
  type: string;
  title: string;
  description: string;
  action: string;
}

export function findBoilerplateIds(entries: readonly BoilerplateCandidate[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'Requirement' || entry.action !== 'create') continue;
    const title = entry.title.trim();
    const description = entry.description.trim();
    if (title.length + description.length > MAX_TEXT_CHARS) continue;
    if (OBLIGATION.test(`${title} ${description}`)) continue;
    if (NOTICE_START.some((pattern) => pattern.test(title) || pattern.test(description))) ids.push(entry.localId);
  }
  return ids;
}

export interface BoilerplateWarning {
  kind: 'boilerplate_excluded';
  // The kind's group (info, in the frontend's warningKinds) decides how it is shown; this is the nearest of the three stored severities.
  severity: 'pipeline_issue';
  nodeIds: string[];
  detail: { reason: string };
  raw: string;
}

/**
 * SURVEY only (BASELINE is verbatim and keeps every block). Marks what `findBoilerplateIds` finds as excluded and returns one Info warning
 * naming those items; the items stay in the tree and Include puts one back. An item the reviewer has already decided on is left alone.
 */
export function excludeBoilerplate<T extends BoilerplateCandidate>(
  diff: readonly T[],
  mode: 'baseline' | 'survey',
): { diff: T[]; warning: BoilerplateWarning | null } {
  if (mode !== 'survey') return { diff: [...diff], warning: null };
  const undecided = diff.filter((entry) => (entry as { reviewed?: boolean }).reviewed !== true && (entry as { excluded?: boolean }).excluded === undefined);
  const ids = new Set(findBoilerplateIds(undecided));
  if (ids.size === 0) return { diff: [...diff], warning: null };
  const count = ids.size;
  return {
    diff: diff.map((entry) => (ids.has(entry.localId) ? { ...entry, excluded: true } : entry)),
    warning: {
      kind: 'boilerplate_excluded',
      severity: 'pipeline_issue',
      nodeIds: [...ids],
      detail: { reason: 'notice_text' },
      raw: `${count} ${count === 1 ? 'item looks' : 'items look'} like a notice, not a requirement (a disclaimer, copyright line or revision table), so ${count === 1 ? 'it was' : 'they were'} left out. Include ${count === 1 ? 'it' : 'them'} to write ${count === 1 ? 'it' : 'them'} anyway.`,
    },
  };
}
