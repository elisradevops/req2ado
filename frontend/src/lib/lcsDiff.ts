// Word-level longest-common-subsequence diff for the side-by-side compare view
// (two requirements that appear to disagree, or a proposed item and the
// existing work item it duplicates). Pure and synchronous. It returns tokens,
// never markup: the caller renders them as React text, so nothing in a
// document can be interpreted as HTML.

export type DiffOp = 'same' | 'removed' | 'added';

export interface DiffToken {
  /** The word plus the whitespace that followed it, so joining tokens rebuilds the text exactly. */
  text: string;
  op: DiffOp;
}

export interface SideBySideDiff {
  /** The first text: `same` and `removed` tokens. Joined, they equal the input. */
  left: DiffToken[];
  /** The second text: `same` and `added` tokens. Joined, they equal the input. */
  right: DiffToken[];
  /** 0..1, 2 x common / (words in both). Two empty texts are identical (1). */
  similarity: number;
  /**
   * `words`: a word diff. `lines`: the texts were too long for a word diff, so
   * whole lines are compared. `plain`: too long even for that; no highlighting.
   */
  mode: 'words' | 'lines' | 'plain';
}

/** Above this many words in either text the word diff is skipped. */
export const MAX_WORDS_FOR_WORD_DIFF = 2000;
/** Above this many lines in either text the line diff is skipped too. */
export const MAX_LINES_FOR_LINE_DIFF = 2000;

const WORD = /\S+\s*/g;

function tokenizeWords(text: string): string[] {
  // Leading whitespace belongs to the first token so nothing is lost.
  const leading = /^\s+/.exec(text)?.[0] ?? '';
  const tokens = text.slice(leading.length).match(WORD) ?? [];
  if (leading) {
    if (tokens.length === 0) return [leading];
    tokens[0] = leading + tokens[0];
  }
  return tokens;
}

function tokenizeLines(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g);
  return lines ?? [];
}

const keyOf = (token: string): string => token.trim();

interface Matched {
  /** Index pairs (into a, into b) of tokens in the common subsequence. */
  pairs: Array<[number, number]>;
}

function lcs(a: string[], b: string[]): Matched {
  const n = a.length;
  const m = b.length;
  const pairs: Array<[number, number]> = [];
  // Common prefix and suffix need no table at all, which is most of the work
  // for two versions of the same sentence.
  let start = 0;
  while (start < n && start < m && keyOf(a[start]) === keyOf(b[start])) {
    pairs.push([start, start]);
    start++;
  }
  let endA = n;
  let endB = m;
  const tail: Array<[number, number]> = [];
  while (endA > start && endB > start && keyOf(a[endA - 1]) === keyOf(b[endB - 1])) {
    endA--;
    endB--;
    tail.push([endA, endB]);
  }
  const rows = endA - start;
  const cols = endB - start;
  if (rows > 0 && cols > 0) {
    const width = cols + 1;
    const table = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        table[i * width + j] =
          keyOf(a[start + i]) === keyOf(b[start + j])
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (keyOf(a[start + i]) === keyOf(b[start + j])) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }
  tail.reverse();
  pairs.push(...tail);
  return { pairs };
}

function build(a: string[], b: string[]): { left: DiffToken[]; right: DiffToken[]; common: number } {
  const { pairs } = lcs(a, b);
  const left: DiffToken[] = [];
  const right: DiffToken[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    while (i < pi) left.push({ text: a[i++], op: 'removed' });
    while (j < pj) right.push({ text: b[j++], op: 'added' });
    // Matched tokens may differ only in trailing whitespace; each side keeps its own.
    left.push({ text: a[i++], op: 'same' });
    right.push({ text: b[j++], op: 'same' });
  }
  while (i < a.length) left.push({ text: a[i++], op: 'removed' });
  while (j < b.length) right.push({ text: b[j++], op: 'added' });
  return { left, right, common: pairs.length };
}

function ratio(common: number, a: number, b: number): number {
  return a + b === 0 ? 1 : (2 * common) / (a + b);
}

export function diffSideBySide(first: string, second: string): SideBySideDiff {
  const wordsA = tokenizeWords(first);
  const wordsB = tokenizeWords(second);
  if (wordsA.length <= MAX_WORDS_FOR_WORD_DIFF && wordsB.length <= MAX_WORDS_FOR_WORD_DIFF) {
    const { left, right, common } = build(wordsA, wordsB);
    return { left, right, similarity: ratio(common, wordsA.length, wordsB.length), mode: 'words' };
  }
  const linesA = tokenizeLines(first);
  const linesB = tokenizeLines(second);
  if (linesA.length <= MAX_LINES_FOR_LINE_DIFF && linesB.length <= MAX_LINES_FOR_LINE_DIFF) {
    const { left, right, common } = build(linesA, linesB);
    return { left, right, similarity: ratio(common, linesA.length, linesB.length), mode: 'lines' };
  }
  return {
    left: first ? [{ text: first, op: 'same' }] : [],
    right: second ? [{ text: second, op: 'same' }] : [],
    similarity: first === second ? 1 : 0,
    mode: 'plain',
  };
}
