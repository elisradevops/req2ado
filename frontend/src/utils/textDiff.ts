import { diffArrays } from 'diff';

// The word-level comparison of an item's description with a suggested one (DESIGN.md §11.4.6). Never by characters. The text is split into
// blocks (paragraphs, list items, trusted <table> blocks), the blocks are aligned, and the words inside a changed block are compared. Tokens are
// Unicode words, so Hebrew and other scripts compare like Latin text, and an identifier or a number with its separators ("P-SENSOR-001#",
// "3.2.1", "18–36", "461G") is ONE token: a dropped one shows as a single deletion, not as scattered pieces.

export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };

export type DiffBlock =
  // Identical in both texts.
  | { kind: 'same'; text: string }
  // A paragraph or list item whose words changed.
  | { kind: 'changed'; parts: DiffPart[] }
  | { kind: 'added'; text: string }
  | { kind: 'removed'; text: string }
  // A table that is identical in both texts.
  | { kind: 'table-same'; html: string }
  // A table with the same rows and columns, compared cell by cell.
  | { kind: 'table-cells'; rows: DiffPart[][][] }
  // A table whose shape changed, or that was added or removed: both versions are shown whole.
  | { kind: 'table-replaced'; before: string | null; after: string | null };

export interface DescriptionDiff {
  blocks: DiffBlock[];
  // Contiguous runs of deleted or inserted words (a replaced word is one change).
  changes: { replaced: number; added: number; removed: number };
  // Deleted plus inserted words, as a share of all the words in both texts: 0 for identical texts, 1 for nothing in common.
  changedShare: number;
  // Past this many words the comparison is skipped (it would be slow and unreadable); the caller shows both texts instead.
  tooLarge: boolean;
}

export const MAX_DIFF_TOKENS = 20_000;
// Matches ui/Markdown.tsx's TABLE_BLOCK_PATTERN: the only raw HTML a description legitimately holds.
const TABLE_BLOCK = /<table[^>]*>[\s\S]*?<\/table>/g;
// A word with its inner separators, so identifiers and numbers stay whole; trailing # belongs to an identifier ("P-SENSOR-001#").
const WORD = /[\p{L}\p{N}]+(?:[-._/–:][\p{L}\p{N}]+)*#?/gu;

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFC');
  const tokens: string[] = [];
  let last = 0;
  for (const match of normalized.matchAll(WORD)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push(...splitOther(normalized.slice(last, index)));
    tokens.push(match[0]);
    last = index + match[0].length;
  }
  if (last < normalized.length) tokens.push(...splitOther(normalized.slice(last)));
  return tokens;
}

// What is between words: each run of whitespace is a token, each other character is a token.
function splitOther(text: string): string[] {
  return text.match(/\s+|[^\s]/gu) ?? [];
}

const isSpace = (token: string): boolean => /^\s+$/.test(token);
const wordCount = (tokens: string[]): number => tokens.filter((token) => !isSpace(token)).length;

type Segment = { kind: 'text'; text: string } | { kind: 'table'; html: string };

// Plain text of a markdown block for comparison and display: the emphasis marks are not part of what changed.
function plain(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/[ \t]+/g, ' ').trim();
}

function segmentsOf(description: string): Segment[] {
  const out: Segment[] = [];
  const tables = description.match(TABLE_BLOCK) ?? [];
  const texts = description.split(TABLE_BLOCK);
  texts.forEach((chunk, index) => {
    for (const paragraph of chunk.split(/\n\s*\n/)) {
      // Each list item is its own block, so adding one item does not mark its neighbours as changed.
      const lines = paragraph.split('\n');
      const isList = lines.length > 1 && lines.some((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line));
      for (const piece of isList ? lines : [paragraph]) {
        const text = plain(piece);
        if (text) out.push({ kind: 'text', text });
      }
    }
    if (tables[index]) out.push({ kind: 'table', html: tables[index] });
  });
  return out;
}

function cellsOf(html: string): string[][] | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (rows.length === 0) return null;
  return rows.map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => plain(cell.textContent ?? '')));
}

function sameShape(a: string[][], b: string[][]): boolean {
  return a.length === b.length && a.every((row, index) => row.length === b[index].length);
}

function mergeParts(parts: DiffPart[]): DiffPart[] {
  const merged: DiffPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.kind === part.kind) last.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

// Words inside one pair of blocks. Whitespace that sits between two changes is part of the change, so "support power" -> "accept an input" reads as
// one replacement and not as two words with a space left standing between them.
function diffWords(before: string, after: string): { parts: DiffPart[]; deleted: number; inserted: number } {
  const a = tokenize(before);
  const b = tokenize(after);
  const raw: DiffPart[] = [];
  for (const change of diffArrays(a, b)) {
    const text = change.value.join('');
    raw.push({ kind: change.added ? 'ins' : change.removed ? 'del' : 'same', text });
  }
  // Fold a lone whitespace "same" run between two changes into them.
  const folded: DiffPart[] = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i];
    const prev = folded[folded.length - 1];
    const next = raw[i + 1];
    if (part.kind === 'same' && isSpace(part.text) && prev && prev.kind !== 'same' && next && next.kind !== 'same') {
      folded.push({ kind: 'del', text: part.text }, { kind: 'ins', text: part.text });
      continue;
    }
    folded.push(part);
  }
  // Group so a replacement reads "deleted, then inserted" however the algorithm interleaved them.
  const ordered: DiffPart[] = [];
  let dels: DiffPart[] = [];
  let inss: DiffPart[] = [];
  const flush = () => {
    ordered.push(...mergeParts(dels), ...mergeParts(inss));
    dels = [];
    inss = [];
  };
  for (const part of folded) {
    if (part.kind === 'del') dels.push(part);
    else if (part.kind === 'ins') inss.push(part);
    else {
      flush();
      ordered.push(part);
    }
  }
  flush();
  const parts = mergeParts(ordered);
  const count = (kind: 'del' | 'ins') => parts.filter((part) => part.kind === kind).reduce((sum, part) => sum + wordCount(tokenize(part.text)), 0);
  return { parts, deleted: count('del'), inserted: count('ins') };
}

function countChanges(parts: DiffPart[], into: DescriptionDiff['changes']): void {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].kind === 'same') continue;
    const hasDel = parts[i].kind === 'del';
    const nextIsIns = hasDel && parts[i + 1]?.kind === 'ins';
    if (nextIsIns) {
      into.replaced += 1;
      i += 1;
    } else if (hasDel) into.removed += 1;
    else into.added += 1;
  }
}

export function diffDescriptions(before: string, after: string): DescriptionDiff {
  const result: DescriptionDiff = { blocks: [], changes: { replaced: 0, added: 0, removed: 0 }, changedShare: 0, tooLarge: false };
  const a = segmentsOf(before);
  const b = segmentsOf(after);
  const size = (segments: Segment[]) => segments.reduce((sum, s) => sum + wordCount(tokenize(s.kind === 'text' ? s.text : plain(s.html.replace(/<[^>]*>/g, ' ')))), 0);
  const totalWords = size(a) + size(b);
  if (totalWords > MAX_DIFF_TOKENS) return { ...result, tooLarge: true, changedShare: 1 };

  let changedWords = 0;
  const key = (s: Segment) => (s.kind === 'text' ? `t:${s.text}` : `h:${s.html}`);
  const aligned = diffArrays(a.map(key), b.map(key));
  let ai = 0;
  let bi = 0;
  const count = (words: number) => {
    changedWords += words;
  };
  for (let r = 0; r < aligned.length; r++) {
    const run = aligned[r];
    if (!run.added && !run.removed) {
      for (let n = 0; n < run.count; n++) {
        const seg = a[ai++];
        bi++;
        result.blocks.push(seg.kind === 'text' ? { kind: 'same', text: seg.text } : { kind: 'table-same', html: seg.html });
      }
      continue;
    }
    if (run.removed) {
      // diffArrays emits what was removed before what replaced it: pair them in order, a table only with a table.
      const removed = a.slice(ai, ai + run.count);
      ai += run.count;
      let added: Segment[] = [];
      const next = aligned[r + 1];
      if (next?.added) {
        added = b.slice(bi, bi + next.count);
        bi += next.count;
        r += 1;
      }
      for (let n = 0; n < Math.max(removed.length, added.length); n++) pushPair(removed[n], added[n], result, count);
      continue;
    }
    for (let n = 0; n < run.count; n++) pushPair(undefined, b[bi++], result, count);
  }
  result.changedShare = totalWords === 0 ? 0 : changedWords / totalWords;
  return result;
}

function pushPair(was: Segment | undefined, now: Segment | undefined, result: DescriptionDiff, addWords: (n: number) => void): void {
  if (was?.kind === 'text' && now?.kind === 'text') {
    const { parts, deleted, inserted } = diffWords(was.text, now.text);
    addWords(deleted + inserted);
    countChanges(parts, result.changes);
    result.blocks.push({ kind: 'changed', parts });
    return;
  }
  if (was?.kind === 'table' && now?.kind === 'table') {
    const x = cellsOf(was.html);
    const y = cellsOf(now.html);
    if (x && y && sameShape(x, y)) {
      const rows = x.map((row, r) =>
        row.map((cell, c) => {
          const { parts, deleted, inserted } = diffWords(cell, y[r][c]);
          addWords(deleted + inserted);
          countChanges(parts, result.changes);
          return parts;
        }),
      );
      result.blocks.push({ kind: 'table-cells', rows });
    } else {
      result.changes.replaced += 1;
      addWords(wordCount(tokenize(plain(was.html.replace(/<[^>]*>/g, ' ')))) + wordCount(tokenize(plain(now.html.replace(/<[^>]*>/g, ' ')))));
      result.blocks.push({ kind: 'table-replaced', before: was.html, after: now.html });
    }
    return;
  }
  // One side is missing, or a table was swapped for text: show the removed and the added block separately.
  if (was) emitOne(was, 'removed', result, addWords);
  if (now) emitOne(now, 'added', result, addWords);
}

function emitOne(segment: Segment, kind: 'added' | 'removed', result: DescriptionDiff, addWords: (n: number) => void): void {
  if (segment.kind === 'text') {
    addWords(wordCount(tokenize(segment.text)));
    result.changes[kind] += 1;
    result.blocks.push({ kind, text: segment.text });
  } else {
    addWords(wordCount(tokenize(plain(segment.html.replace(/<[^>]*>/g, ' ')))));
    result.changes[kind] += 1;
    result.blocks.push({ kind: 'table-replaced', before: kind === 'removed' ? segment.html : null, after: kind === 'added' ? segment.html : null });
  }
}
