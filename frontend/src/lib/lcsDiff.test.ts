import { describe, it, expect } from 'vitest';
import { diffSideBySide, MAX_LINES_FOR_LINE_DIFF, MAX_WORDS_FOR_WORD_DIFF, type DiffToken } from './lcsDiff';

const join = (tokens: DiffToken[], ...ops: Array<DiffToken['op']>): string =>
  tokens.filter((t) => ops.includes(t.op)).map((t) => t.text).join('');
const changed = (tokens: DiffToken[], op: DiffToken['op']): string[] =>
  tokens.filter((t) => t.op === op).map((t) => t.text.trim());

describe('diffSideBySide', () => {
  it('marks only the differing values in two near-identical requirements', () => {
    const a = 'The power supply shall provide 500 W at 28 VAC input.';
    const b = 'The power supply shall provide 600 W at 28 VDC input.';
    const d = diffSideBySide(a, b);
    expect(d.mode).toBe('words');
    expect(changed(d.left, 'removed')).toEqual(['500', 'VAC']);
    expect(changed(d.right, 'added')).toEqual(['600', 'VDC']);
  });

  it('rebuilds both inputs exactly from the tokens', () => {
    const a = '  Leading space, tabs\tand\nnewlines   stay. ';
    const b = 'Leading space and\nnewlines stay, with extras. ';
    const d = diffSideBySide(a, b);
    expect(join(d.left, 'same', 'removed')).toBe(a);
    expect(join(d.right, 'same', 'added')).toBe(b);
  });

  it('reconstructs both inputs for many random word sequences (property)', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const vocab = ['shall', 'the', 'unit', '28', 'V', 'DC', 'input', 'range', 'at', 'least', 'volts', '5%'];
    const make = (): string =>
      Array.from({ length: rand(25) }, () => vocab[rand(vocab.length)] + (rand(5) === 0 ? '  ' : ' ')).join('');
    for (let i = 0; i < 300; i++) {
      const a = make();
      const b = make();
      const d = diffSideBySide(a, b);
      expect(join(d.left, 'same', 'removed')).toBe(a);
      expect(join(d.right, 'same', 'added')).toBe(b);
      expect(d.similarity).toBeGreaterThanOrEqual(0);
      expect(d.similarity).toBeLessThanOrEqual(1);
      // The common words really are common, in order, on both sides.
      expect(changed(d.left, 'same')).toEqual(changed(d.right, 'same'));
    }
  });

  it('finds a longest common subsequence, not just a prefix', () => {
    const d = diffSideBySide('a b c d e f', 'x a c e f y');
    expect(changed(d.left, 'same')).toEqual(['a', 'c', 'e', 'f']);
    expect(changed(d.left, 'removed')).toEqual(['b', 'd']);
    expect(changed(d.right, 'added')).toEqual(['x', 'y']);
  });

  it('scores similarity as the shared share of both texts', () => {
    expect(diffSideBySide('same words here', 'same words here').similarity).toBe(1);
    expect(diffSideBySide('a b c d', 'e f g h').similarity).toBe(0);
    expect(diffSideBySide('a b c d', 'a b x y').similarity).toBe(0.5);
    expect(diffSideBySide('', '').similarity).toBe(1);
    expect(diffSideBySide('a b', '').similarity).toBe(0);
  });

  it('handles empty and whitespace-only sides', () => {
    expect(diffSideBySide('', 'new words').left).toEqual([]);
    const blank = diffSideBySide('   ', 'x');
    expect(join(blank.left, 'same', 'removed')).toBe('   ');
  });

  it('keeps markup as plain text; nothing is interpreted', () => {
    const d = diffSideBySide('<img src=x onerror=alert(1)> ok', '<script>alert(1)</script> ok');
    expect(join(d.left, 'same', 'removed')).toBe('<img src=x onerror=alert(1)> ok');
    expect(d.left.every((t) => typeof t.text === 'string')).toBe(true);
  });

  it('treats a word that differs only in trailing space as the same word', () => {
    const d = diffSideBySide('a b c', 'a b c ');
    expect(changed(d.left, 'removed')).toEqual([]);
    expect(changed(d.right, 'added')).toEqual([]);
  });

  it('falls back to a line diff above the word limit', () => {
    const big = (suffix: string): string =>
      Array.from({ length: MAX_WORDS_FOR_WORD_DIFF + 50 }, (_, i) => `w${i}`).join(' ') + '\n' + suffix + '\n';
    const d = diffSideBySide(big('last line A'), big('last line B'));
    expect(d.mode).toBe('lines');
    expect(changed(d.left, 'removed')).toEqual(['last line A']);
    expect(changed(d.right, 'added')).toEqual(['last line B']);
    expect(join(d.left, 'same', 'removed')).toBe(big('last line A'));
  });

  it('shows plain text when even the lines are too many', () => {
    const lines = (tag: string): string =>
      Array.from({ length: MAX_LINES_FOR_LINE_DIFF + 10 }, (_, i) => `${tag}${i} x x`).join('\n');
    const d = diffSideBySide(lines('a'), lines('b'));
    expect(d.mode).toBe('plain');
    expect(d.left).toHaveLength(1);
    expect(d.left[0].op).toBe('same');
  });

  it('stays fast at the word limit', () => {
    const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i % 90}`).join(' ');
    const start = performance.now();
    const d = diffSideBySide(words(MAX_WORDS_FOR_WORD_DIFF, 'p'), words(MAX_WORDS_FOR_WORD_DIFF, 'q'));
    expect(d.mode).toBe('words');
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
