import { describe, expect, it } from 'vitest';
import { diffDescriptions, MAX_DIFF_TOKENS, tokenize, type DiffPart } from './textDiff';

const kinds = (parts: DiffPart[]) => parts.map((part) => `${part.kind}:${part.text}`);
const table = (rows: string[][]) =>
  `<table><tr>${rows[0].map((c) => `<th>${c}</th>`).join('')}</tr>${rows
    .slice(1)
    .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</table>`;

describe('tokenize', () => {
  it('keeps an identifier, a version and a range whole, and a number with its unit letters whole', () => {
    expect(tokenize('See P-SENSOR-001# and 3.2.1 within 18–36 V at 461G.').filter((t) => !/^\s+$/.test(t))).toEqual([
      'See',
      'P-SENSOR-001#',
      'and',
      '3.2.1',
      'within',
      '18–36',
      'V',
      'at',
      '461G',
      '.',
    ]);
  });

  it('treats Hebrew letters as word characters, so a Hebrew word is one token, and does not split a Latin token inside Hebrew text', () => {
    expect(tokenize('המערכת תבצע סנכרון לפי XYZ-2').filter((t) => !/^\s+$/.test(t))).toEqual(['המערכת', 'תבצע', 'סנכרון', 'לפי', 'XYZ-2']);
  });

  it('normalises to NFC, so a letter written with a combining mark equals its precomposed form', () => {
    expect(tokenize('é')).toEqual(tokenize('é'));
  });
});

describe('diffDescriptions: paragraphs and lists', () => {
  it('is empty of changes for identical texts', () => {
    const diff = diffDescriptions('The unit shall boot.', 'The unit shall boot.');
    expect(diff.changes).toEqual({ replaced: 0, added: 0, removed: 0 });
    expect(diff.changedShare).toBe(0);
    expect(diff.blocks).toEqual([{ kind: 'same', text: 'The unit shall boot.' }]);
  });

  it('marks a replaced word as a deletion followed by an insertion, and counts it as one replacement', () => {
    const diff = diffDescriptions('The unit shall support power.', 'The unit shall accept power.');
    const block = diff.blocks[0];
    expect(block.kind).toBe('changed');
    if (block.kind !== 'changed') return;
    expect(kinds(block.parts)).toEqual(['same:The unit shall ', 'del:support', 'ins:accept', 'same: power.']);
    expect(diff.changes).toEqual({ replaced: 1, added: 0, removed: 0 });
  });

  it('shows a dropped identifier as one deletion', () => {
    const diff = diffDescriptions('Use connector P-CON-001# for power.', 'Use a connector for power.');
    const block = diff.blocks[0];
    if (block.kind !== 'changed') throw new Error('expected a changed block');
    expect(block.parts.filter((p) => p.kind === 'del').map((p) => p.text.trim())).toContain('P-CON-001#');
    expect(block.parts.some((p) => p.kind === 'del' && p.text.includes('P-CON'))).toBe(true);
  });

  it('counts an added block and a removed block, and leaves unchanged neighbours alone', () => {
    const diff = diffDescriptions('First.\n\nSecond.', 'First.\n\nSecond.\n\nThird.');
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'same', 'added']);
    expect(diff.changes).toEqual({ replaced: 0, added: 1, removed: 0 });
    const reverse = diffDescriptions('First.\n\nSecond.\n\nThird.', 'First.\n\nSecond.');
    expect(reverse.blocks.map((b) => b.kind)).toEqual(['same', 'same', 'removed']);
    expect(reverse.changes.removed).toBe(1);
  });

  it('treats each list item as its own block, so adding one item does not mark the others', () => {
    const diff = diffDescriptions('- alpha\n- beta', '- alpha\n- beta\n- gamma');
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'same', 'added']);
  });

  it('compares Hebrew text word by word, and keeps a Latin identifier inside it whole', () => {
    const diff = diffDescriptions('המערכת תבצע סנכרון כל N שניות לפי XYZ-2', 'המערכת תבצע סנכרון כל 5 שניות לפי XYZ-2');
    const block = diff.blocks[0];
    if (block.kind !== 'changed') throw new Error('expected a changed block');
    expect(block.parts.filter((p) => p.kind !== 'same').map((p) => `${p.kind}:${p.text}`)).toEqual(['del:N', 'ins:5']);
  });

  it('ignores emphasis marks: they are not what changed', () => {
    const diff = diffDescriptions('The unit **shall** boot.', 'The unit shall boot.');
    expect(diff.changes).toEqual({ replaced: 0, added: 0, removed: 0 });
  });

  it('reports the share of words that changed: small for an edit, large for a rewrite', () => {
    const edit = diffDescriptions('The unit shall support power input within range of the supply.', 'The unit shall accept power input within range of the supply.');
    const rewrite = diffDescriptions('The unit shall support power input.', 'Operators must configure voltage limits during commissioning.');
    expect(edit.changedShare).toBeLessThan(0.4);
    expect(rewrite.changedShare).toBeGreaterThan(0.4);
  });

  it('skips a comparison that is too large and says so', () => {
    const huge = Array.from({ length: MAX_DIFF_TOKENS }, (_, i) => `w${i}`).join(' ');
    expect(diffDescriptions(huge, `${huge} extra`).tooLarge).toBe(true);
    expect(diffDescriptions('a b', 'a c').tooLarge).toBe(false);
  });
});

describe('diffDescriptions: tables', () => {
  const before = table([['Parameter', 'Value'], ['Rate', 'N Hz']]);

  it('leaves an identical table alone', () => {
    const diff = diffDescriptions(`Intro.\n\n${before}`, `Intro.\n\n${before}`);
    expect(diff.blocks.map((b) => b.kind)).toEqual(['same', 'table-same']);
  });

  it('compares a table with the same rows and columns cell by cell', () => {
    const after = table([['Parameter', 'Value'], ['Rate', '5 Hz']]);
    const diff = diffDescriptions(before, after);
    const block = diff.blocks[0];
    if (block.kind !== 'table-cells') throw new Error('expected table-cells');
    expect(block.rows[1][1].filter((p) => p.kind !== 'same').map((p) => `${p.kind}:${p.text}`)).toEqual(['del:N', 'ins:5']);
    expect(block.rows[1][0]).toEqual([{ kind: 'same', text: 'Rate' }]);
    expect(diff.changes.replaced).toBe(1);
  });

  it('shows both versions whole when the shape of a table changed', () => {
    const after = table([['Parameter', 'Value', 'Unit'], ['Rate', '5', 'Hz']]);
    const diff = diffDescriptions(before, after);
    expect(diff.blocks).toEqual([{ kind: 'table-replaced', before, after }]);
  });

  it('shows a table that was added or removed whole', () => {
    expect(diffDescriptions('Intro.', `Intro.\n\n${before}`).blocks.map((b) => b.kind)).toEqual(['same', 'table-replaced']);
    expect(diffDescriptions(`Intro.\n\n${before}`, 'Intro.').blocks.map((b) => b.kind)).toEqual(['same', 'table-replaced']);
  });
});
