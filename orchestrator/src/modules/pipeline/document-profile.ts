import type { Block, CanonicalDoc, Table, WorkItemTree } from '@req2ado/shared-ts';

// The deterministic profile of a parsed document: what it is for, how it is built and how far its structure can be trusted. Made from
// the text and structure alone (no model), so the wizard shows it at once, it is the same on every run, and every line can be traced
// to the file. The SURVEY job's own study (what the model reads in windows) is a separate, slower stage and is not needed to show it.

export interface ProfilePurpose {
  number: string | null;
  title: string;
  text: string;
  truncated: boolean;
}

export interface ProfileOutlineEntry {
  number: string | null;
  title: string;
  subsections: number;
  requirements: number;
  tables: number;
  figures: number;
  unresolved: number;
}

export interface ProfileUnresolved {
  marker: string;
  count: number;
  sections: string[];
}

/** What the deterministic baseline parser builds from this document: counts by work item type, and how deeply they nest. */
export interface BaselineTreeShape {
  epics: number;
  features: number;
  requirements: number;
  depth: number;
  roots: number;
}

export interface DocumentProfile {
  format: string;
  /** Absent when the baseline tree could not be had in time (the overview is shown without it). */
  baselineTree?: BaselineTreeShape;
  /** The bounded text the optional AI summary is written from (and checked against): purpose, outline, each section's opening sentence, cited standards. */
  summaryInput: string;
  purpose: ProfilePurpose | null;
  outline: ProfileOutlineEntry[];
  unresolved: ProfileUnresolved[];
  standards: { count: number; examples: string[]; applicableDocuments: { section: string; entries: number } | null };
  glossary: { section: string; entries: number } | null;
  structure: {
    sectionCount: number;
    depth: number;
    numberedHeadings: number;
    requirementHeadings: number;
    levelJumps: number;
    tables: number;
    figures: number;
    blocks: number;
    headingDetection: 'reliable' | 'partial' | 'none';
    ocr: 'none' | 'partial' | 'scanned';
    notes: string[];
  };
}

const PURPOSE_CHARS = 1500;
const TITLE_CHARS = 100;
const MAX_LISTED = 8;
const MAX_SECTIONS_PER_MARKER = 5;
// A purpose heading wins over a general one: "Scope" says what the document is for, "Introduction" often only frames it.
const PURPOSE_HEADINGS = [/(?<![a-z])(?:scope|purpose)(?![a-z])|מטרה|תחולה/i, /(?<![a-z])(?:introduction|overview)(?![a-z])|מבוא|הקדמה|סקירה/i];
// "Out of Scope" and "General Purpose ..." name what the document does not cover or something else entirely.
const NOT_A_PURPOSE = /out of scope|not in scope|general[- ]purpose|מחוץ ל|אינו כולל|לא כולל/i;
const APPLICABLE_HEADING = /applicable documents|referenced? documents|references|מסמכים ישימים|מסמכים רלוונטיים|מסמכי ייחוס/i;
const GLOSSARY_HEADING = /glossary|acronyms?|abbreviations|definitions|terms and|מילון|ראשי תיבות|הגדרות/i;
const SHALL = /\bshall\b/i;
// X placeholders need three X (or XX with a lowercase x after): a bare XX is the Roman numeral twenty ("Annex XX").
// A part number such as XXX-123 or XXX/7 is not a placeholder.
const MARKER = /\b(?:TBD|TBC|TBR|TBS)\b|\bX{3,}[xX]*\b(?![-/]\d)|\bXX[xX]+\b(?![-/]\d)/g;
const STANDARD =
  /\bMIL-(?:STD|HDBK|PRF|DTL|C|W|E|I)-\d+[A-Z]?\b|\bVITA\s?\d+(?:\.\d+)?\b|\b(?:IEEE|ISO|IEC|ARINC|STANAG|RTCA\s?DO|ASTM|EN|ITU-T)[-\s]?\d+[A-Z]?(?:[.-]\d+)*\b/g;

// A parsed block always has text; a missing one is read as empty rather than failing the whole overview.
const textOf = (block: Block): string => block.text ?? '';
/** The text without zero-width characters, which some parsers leave behind as a "paragraph". */
const visible = (text: string): string => text.replace(/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, '').trim();
const PURPOSE_HEADING_CHARS = 60;
const sectionLabel = (heading: Block): string => `${heading.number_label ?? ''} ${textOf(heading)}`.trim().slice(0, TITLE_CHARS);
const isBody = (block: Block): boolean => block.kind === 'paragraph' || block.kind === 'list_item';

function levelOf(heading: Block): number {
  if (typeof heading.heading_level === 'number') return heading.heading_level;
  if (heading.number_label) return heading.number_label.split('.').length;
  return 1;
}

/** The blocks after the heading at `index`, up to the next heading at the same or a shallower level. */
function sectionBody(blocks: Block[], index: number): Block[] {
  const level = levelOf(blocks[index]);
  const body: Block[] = [];
  for (let i = index + 1; i < blocks.length; i += 1) {
    if (blocks[i].kind === 'heading' && levelOf(blocks[i]) <= level) break;
    body.push(blocks[i]);
  }
  return body;
}

function cutAtWord(text: string, limit: number): { text: string; truncated: boolean } {
  const points = Array.from(text); // code points: never half of an emoji
  if (points.length <= limit) return { text, truncated: false };
  const cut = points.slice(0, limit);
  if (/\s/.test(points[limit])) return { text: cut.join('').trimEnd(), truncated: true };
  let end = cut.length;
  while (end > 0 && !/\s/.test(cut[end - 1])) end -= 1;
  return { text: cut.slice(0, end > 0 ? end : cut.length).join('').trimEnd(), truncated: true };
}

function findPurpose(blocks: Block[]): ProfilePurpose | null {
  for (const pattern of PURPOSE_HEADINGS) {
    for (let i = 0; i < blocks.length; i += 1) {
      // A purpose heading is short: a long heading that mentions "scope" is a requirement or a note, not the section that says what the document is for.
      if (blocks[i].kind !== 'heading' || !pattern.test(textOf(blocks[i])) || NOT_A_PURPOSE.test(textOf(blocks[i]))) continue;
      if (textOf(blocks[i]).trim().length > PURPOSE_HEADING_CHARS || SHALL.test(textOf(blocks[i]))) continue;
      // Only the text directly under the heading (up to the next heading of any level), so a quote never wanders into another section.
      const own: string[] = [];
      for (let j = i + 1; j < blocks.length && blocks[j].kind !== 'heading'; j += 1) if (isBody(blocks[j]) && visible(textOf(blocks[j]))) own.push(visible(textOf(blocks[j])));
      if (own.length === 0) continue;
      const cut = cutAtWord(own.join(' '), PURPOSE_CHARS);
      return { number: blocks[i].number_label ?? null, title: textOf(blocks[i]), text: cut.text, truncated: cut.truncated };
    }
  }
  // A file with headings but no Scope, Purpose or Introduction section does not say what it is for: its first paragraph is not its purpose.
  if (blocks.some((block) => block.kind === 'heading')) return null;
  const opening = blocks.find((block) => block.kind === 'paragraph' && visible(textOf(block)).length >= 40);
  if (!opening) return null;
  const cut = cutAtWord(visible(textOf(opening)), PURPOSE_CHARS);
  return { number: null, title: '', text: cut.text, truncated: cut.truncated };
}

function markersIn(text: string): string[] {
  return text.match(MARKER) ?? [];
}

function addMarkers(found: Map<string, { count: number; sections: string[] }>, text: string, section: string): void {
  for (const marker of markersIn(text)) {
    const entry = found.get(marker) ?? { count: 0, sections: [] };
    entry.count += 1;
    if (section && !entry.sections.includes(section) && entry.sections.length < MAX_SECTIONS_PER_MARKER) entry.sections.push(section);
    found.set(marker, entry);
  }
}

/** Unresolved markers in the text blocks and, after them, in the table cells, each with the section it is found in. */
function findUnresolved(blocks: Block[], placed: PlacedTable[]): ProfileUnresolved[] {
  const found = new Map<string, { count: number; sections: string[] }>();
  let section = '';
  for (const block of blocks) {
    // A heading is text too: some files write their open values in headings ("Max power TBD W").
    if (block.kind === 'heading') section = sectionLabel(block);
    addMarkers(found, textOf(block), section);
  }
  for (const { table, section: where } of placed) {
    for (const row of table.cells) for (const cell of row) if (cell) addMarkers(found, cell.text ?? '', where);
  }
  return [...found].map(([marker, entry]) => ({ marker, ...entry }));
}

function findStandards(blocks: Block[]): string[] {
  const seen: string[] = [];
  for (const block of blocks) {
    for (const match of textOf(block).match(STANDARD) ?? []) {
      const normalized = match.replace(/\s+/g, ' ').trim();
      if (!seen.includes(normalized)) seen.push(normalized);
    }
  }
  return seen;
}

function entriesOf(blocks: Block[], index: number): number {
  return sectionBody(blocks, index).filter(isBody).length;
}

function findSection(blocks: Block[], pattern: RegExp): { section: string; entries: number } | null {
  const index = blocks.findIndex((block) => block.kind === 'heading' && pattern.test(textOf(block)));
  return index < 0 ? null : { section: sectionLabel(blocks[index]), entries: entriesOf(blocks, index) };
}

interface PlacedTable {
  table: Table;
  section: string;
  entry: ProfileOutlineEntry | undefined;
}

const offsetOf = (item: { source_ref?: { start_offset?: number | null } | null }): number | undefined => {
  const offset = item.source_ref?.start_offset;
  return typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined;
};

/** Each table in the section whose heading precedes it in the file (tables are not blocks: their place is their offset). */
function placeTables(blocks: Block[], tables: Table[], entryOf: Map<Block, ProfileOutlineEntry>): PlacedTable[] {
  const marks = blocks
    .filter((block) => block.kind === 'heading' && offsetOf(block) !== undefined)
    .map((heading) => ({ heading, offset: offsetOf(heading) as number }))
    .sort((a, b) => a.offset - b.offset);
  return tables.map((table) => {
    const at = offsetOf(table);
    const mark = at === undefined ? undefined : [...marks].reverse().find((m) => m.offset <= at);
    return { table, section: mark ? sectionLabel(mark.heading) : '', entry: mark ? entryOf.get(mark.heading) : undefined };
  });
}

function buildOutline(blocks: Block[], entryOf: Map<Block, ProfileOutlineEntry>): ProfileOutlineEntry[] {
  const headings = blocks.filter((block) => block.kind === 'heading');
  if (headings.length === 0) return [];
  const top = headings.reduce((least, heading) => Math.min(least, levelOf(heading)), Infinity);
  const outline: ProfileOutlineEntry[] = [];
  let current: ProfileOutlineEntry | null = null;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (levelOf(block) === top) {
        current = { number: block.number_label ?? null, title: textOf(block).slice(0, TITLE_CHARS), subsections: 0, requirements: 0, tables: 0, figures: 0, unresolved: 0 };
        outline.push(current);
      } else if (current) {
        current.subsections += 1;
      }
      if (current) {
        entryOf.set(block, current);
        // A heading that states a requirement is one (a source file may write its requirements as headings).
        if (SHALL.test(textOf(block))) current.requirements += 1;
        current.unresolved += markersIn(textOf(block)).length;
      }
      continue;
    }
    if (!current) continue;
    if (isBody(block) && SHALL.test(textOf(block))) current.requirements += 1;
    if (block.kind === 'table') current.tables += 1;
    if (block.kind === 'figure') current.figures += 1;
    current.unresolved += markersIn(textOf(block)).length;
  }
  return outline;
}

function describeStructure(doc: CanonicalDoc, blocks: Block[]): DocumentProfile['structure'] {
  const headings = blocks.filter((block) => block.kind === 'heading');
  const levels = headings.map(levelOf);
  const numberedHeadings = headings.filter((heading) => Boolean(heading.number_label)).length;
  const requirementHeadings = headings.filter((heading) => SHALL.test(textOf(heading))).length;
  let levelJumps = 0;
  for (let i = 1; i < levels.length; i += 1) if (levels[i] - levels[i - 1] > 1) levelJumps += 1;
  const format = doc.document?.format ?? 'unknown';
  const ocrCells = (doc.tables ?? []).reduce((n, table) => n + table.cells.reduce((rn, row) => rn + row.filter((cell) => cell?.ocr_recovered).length, 0), 0);
  const ocr: 'none' | 'partial' | 'scanned' = format === 'pdf_scanned' ? 'scanned' : ocrCells > 0 ? 'partial' : 'none';
  const headingDetection: 'reliable' | 'partial' | 'none' =
    headings.length === 0 ? 'none' : numberedHeadings / headings.length >= 0.8 && requirementHeadings / headings.length < 0.1 && levelJumps === 0 ? 'reliable' : 'partial';
  const notes: string[] = [];
  if (headings.length === 0) notes.push('No headings were found, so the document has no section structure to build a tree from.');
  if (requirementHeadings > 0) notes.push(`${requirementHeadings} headings state a requirement (they contain "shall"); they are headings in the source file, so they are kept as section headings.`);
  if (headings.length > 0 && numberedHeadings < headings.length) notes.push(`${headings.length - numberedHeadings} of ${headings.length} headings carry no clause number.`);
  if (levelJumps > 0) notes.push(`${levelJumps} headings skip a level (for example from level 1 straight to level 3).`);
  if (ocr === 'scanned') notes.push('Scanned PDF: the text was recovered by OCR, so wording may contain recognition errors.');
  if (ocr === 'partial') notes.push(`${ocrCells} table cells were recovered by OCR.`);
  return {
    sectionCount: headings.length,
    depth: levels.reduce((most, level) => Math.max(most, level), 0),
    numberedHeadings,
    requirementHeadings,
    levelJumps,
    tables: (doc.tables ?? []).length,
    figures: (doc.figures ?? []).length,
    blocks: blocks.length,
    headingDetection,
    ocr,
    notes,
  };
}

export function summarizeBaselineTree(tree: Pick<WorkItemTree, 'nodes'>): BaselineTreeShape {
  const byId = new Map(tree.nodes.map((node) => [node.local_id, node]));
  let depth = 0;
  for (const node of tree.nodes) {
    // Walk up to the root; a parent cycle ends the walk at the first repeat instead of looping.
    const seen = new Set<string>();
    let current: typeof node | undefined = node;
    while (current && !seen.has(current.local_id)) {
      seen.add(current.local_id);
      current = current.parent_local_id ? byId.get(current.parent_local_id) : undefined;
    }
    depth = Math.max(depth, seen.size);
  }
  return {
    epics: tree.nodes.filter((n) => n.type === 'Epic').length,
    features: tree.nodes.filter((n) => n.type === 'Feature').length,
    requirements: tree.nodes.filter((n) => n.type === 'Requirement').length,
    depth,
    roots: tree.nodes.filter((n) => !n.parent_local_id || !byId.has(n.parent_local_id)).length,
  };
}

const SUMMARY_INPUT_CHARS = 6000;
const SUMMARY_SECTIONS = 40;
const SUMMARY_OPENINGS = 12;
const OPENING_SENTENCE_CHARS = 200;

function firstSentence(text: string): string {
  const sentence = visible(text).split(/(?<=[.!?])\s/)[0] ?? '';
  return cutAtWord(sentence, OPENING_SENTENCE_CHARS).text;
}

/** What a summary may be written from, and is checked against: only text the document itself contains, plus its section titles and counts. */
function composeSummaryInput(blocks: Block[], purpose: ProfilePurpose | null, outline: ProfileOutlineEntry[], standards: string[], structure: DocumentProfile['structure']): string {
  const lines: string[] = [];
  if (purpose) lines.push(purpose.number ? `§${purpose.number} ${purpose.title}: ${purpose.text}` : `Opening text: ${purpose.text}`);
  // The real size of the file, so a summary that says "36 figures" is quoting the file, not inventing a number.
  lines.push(`Structure: ${structure.sectionCount} sections, ${structure.depth} levels deep, ${structure.tables} tables, ${structure.figures} figures`);
  if (outline.length > 0) {
    lines.push(`Sections: ${outline.slice(0, SUMMARY_SECTIONS).map((e) => sanitizeHint(`${e.number ?? ''} ${e.title}`, 80)).join('; ')}`);
    const top = blocks.filter((b) => b.kind === 'heading').reduce((least, b) => Math.min(least, levelOf(b)), Infinity);
    let current: ProfileOutlineEntry | undefined;
    let opened = new Set<ProfileOutlineEntry>();
    let index = -1;
    for (const block of blocks) {
      if (block.kind === 'heading' && levelOf(block) === top) {
        index += 1;
        current = outline[index];
        continue;
      }
      if (!current || opened.has(current) || opened.size >= SUMMARY_OPENINGS || !isBody(block)) continue;
      const sentence = firstSentence(textOf(block));
      if (sentence.length < 20) continue;
      opened = opened.add(current);
      lines.push(`${sanitizeHint(`${current.number ?? ''} ${current.title}`, 60)}: ${sentence}`);
    }
  }
  if (standards.length > 0) lines.push(`Cited: ${standards.slice(0, MAX_LISTED).join(', ')}`);
  const joined = lines.join('\n');
  const points = Array.from(joined);
  return points.length <= SUMMARY_INPUT_CHARS ? joined : points.slice(0, SUMMARY_INPUT_CHARS).join('').trimEnd();
}

export function buildDocumentProfile(doc: CanonicalDoc): DocumentProfile {
  const blocks = doc.blocks ?? [];
  const standards = findStandards(blocks);
  const applicable = findSection(blocks, APPLICABLE_HEADING);
  const entryOf = new Map<Block, ProfileOutlineEntry>();
  const outline = buildOutline(blocks, entryOf);
  const placed = placeTables(blocks, doc.tables ?? [], entryOf);
  for (const { table, entry } of placed) {
    if (!entry) continue;
    entry.tables += 1;
    for (const row of table.cells) for (const cell of row) if (cell) entry.unresolved += markersIn(cell.text ?? '').length;
  }
  const purpose = findPurpose(blocks);
  const structure = describeStructure(doc, blocks);
  return {
    format: doc.document?.format ?? 'unknown',
    purpose,
    summaryInput: composeSummaryInput(blocks, purpose, outline, standards, structure),
    outline,
    unresolved: findUnresolved(blocks, placed),
    standards: { count: standards.length, examples: standards.slice(0, MAX_LISTED), applicableDocuments: applicable },
    glossary: findSection(blocks, GLOSSARY_HEADING),
    structure,
  };
}

/** The profile as the lines the wizard shows. Every line is read off the document; the last says so. */
export function composeProfileLines(profile: DocumentProfile): string[] {
  const lines: string[] = [];
  if (!profile.purpose && profile.structure.sectionCount > 0) lines.push('No Scope, Purpose or Introduction section was found, so the file itself does not say what it is for.');
  if (profile.purpose) {
    const where = profile.purpose.number ? `§${profile.purpose.number} ${profile.purpose.title}`.trim() : 'the opening text';
    lines.push(`Purpose, quoted from ${where}: “${profile.purpose.text}”${profile.purpose.truncated ? ' …' : ''}`);
  }
  const s = profile.structure;
  lines.push(
    `Structure: ${s.sectionCount} sections, ${s.depth} levels deep, ${s.tables} tables, ${s.figures} figures. Heading detection looks ${s.headingDetection === 'reliable' ? 'reliable' : s.headingDetection === 'partial' ? 'partly reliable' : 'absent'}.`,
  );
  for (const note of s.notes) lines.push(note);
  if (profile.baselineTree) {
    const t = profile.baselineTree;
    lines.push(`The baseline parser (deterministic, no AI) will build ${t.epics} Epics, ${t.features} Features and ${t.requirements} Requirements from this structure, nested up to ${t.depth} levels.`);
  }
  if (profile.outline.length > 0) {
    const shown = profile.outline.slice(0, MAX_LISTED).map((entry) => `${`${entry.number ?? ''} ${entry.title}`.trim()} (${entry.subsections} ${entry.subsections === 1 ? 'subsection' : 'subsections'}, ${entry.requirements} requirement ${entry.requirements === 1 ? 'statement' : 'statements'})`);
    lines.push(`Top-level sections: ${shown.join('; ')}${profile.outline.length > MAX_LISTED ? `; and ${profile.outline.length - MAX_LISTED} more` : ''}.`);
  }
  if (profile.standards.count > 0) {
    const listed = profile.standards.applicableDocuments;
    const applicable = listed && listed.entries > 0 ? ` ${listed.entries} entries are listed under “${listed.section}”.` : '';
    lines.push(`Cites ${profile.standards.count} standards by name: ${profile.standards.examples.join(', ')}${profile.standards.count > profile.standards.examples.length ? ', …' : ''}.${applicable}`);
  } else if (profile.standards.applicableDocuments && profile.standards.applicableDocuments.entries > 0) {
    lines.push(`${profile.standards.applicableDocuments.entries} entries are listed under “${profile.standards.applicableDocuments.section}”.`);
  }
  if (profile.glossary && profile.glossary.entries > 0) lines.push(`Glossary: ${profile.glossary.entries} entries under “${profile.glossary.section}”.`);
  if (profile.unresolved.length > 0) {
    lines.push(`Unresolved values: ${profile.unresolved.map((u) => `${u.marker} ×${u.count}${u.sections.length > 0 ? ` (${u.sections.join(', ')})` : ''}`).join('; ')}.`);
  }
  lines.push('All of the above is taken from the document’s text and structure; no AI was used.');
  return lines;
}

const STRUCTURE_HINT_CHARS = 1000;
// A full primer (1000) and a full structure hint (1000) with the blank line between them.
const JOINED_CONTEXT_CHARS = 2100;

/** One line, no control characters, cut on a code point boundary: text taken from a document that is about to enter a model prompt. */
export function sanitizeHint(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(oneLine);
  return points.length <= maxChars ? oneLine : points.slice(0, maxChars).join('').trimEnd();
}

/**
 * How the file is built, written for the AI stage of a SURVEY job (appended to its document context): section count and depth, how far the
 * headings can be trusted, what the baseline parser builds from them, and the top-level sections. Context only, and bounded.
 */
export function composeStructureHint(profile: DocumentProfile): string {
  const s = profile.structure;
  const parts = [
    `How this document is built (from its text and structure; context only, never a source of values): ${s.sectionCount} sections, ${s.depth} levels deep, ${s.tables} tables, ${s.figures} figures; heading detection looks ${s.headingDetection === 'reliable' ? 'reliable' : s.headingDetection === 'partial' ? 'partly reliable' : 'absent'}.`,
    ...s.notes,
  ];
  if (profile.baselineTree) {
    const t = profile.baselineTree;
    parts.push(`The deterministic baseline parser builds ${t.epics} Epics, ${t.features} Features and ${t.requirements} Requirements from the headings, nested up to ${t.depth} levels.`);
  }
  if (profile.outline.length > 0) {
    parts.push(`Top-level sections: ${profile.outline.slice(0, MAX_LISTED).map((e) => sanitizeHint(`${e.number ?? ''} ${e.title}`, TITLE_CHARS)).join('; ')}${profile.outline.length > MAX_LISTED ? '; …' : ''}.`);
  }
  const hint = sanitizeHint(parts.join(' '), STRUCTURE_HINT_CHARS + 1);
  return Array.from(hint).length <= STRUCTURE_HINT_CHARS ? hint : `${sanitizeHint(hint, STRUCTURE_HINT_CHARS - 1)}…`;
}

/** The non-empty contexts joined in order with a blank line; undefined when there is none. */
export function joinContexts(...contexts: (string | undefined)[]): string | undefined {
  const present = contexts.map((c) => c?.trim()).filter((c): c is string => Boolean(c));
  if (present.length === 0) return undefined;
  const joined = present.join('\n\n');
  const points = Array.from(joined);
  return points.length <= JOINED_CONTEXT_CHARS ? joined : points.slice(0, JOINED_CONTEXT_CHARS).join('').trimEnd();
}
