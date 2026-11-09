import { canonicalizeForCompare, composeAdoDescriptionHtml, normalizeAdoStoredHtml, splitProposal, toAdoDescriptionHtml } from '../src/modules/pipeline/description-html';

describe('toAdoDescriptionHtml', () => {
  it('wraps plain prose in a paragraph', () => {
    expect(toAdoDescriptionHtml('The backplane shall support 7 slots.')).toBe('<p>The backplane shall support 7 slots.</p>\n');
  });

  it('converts **bold**, *italic*, and ~~strikethrough~~ to real tags', () => {
    const html = toAdoDescriptionHtml('This is **bold**, *italic*, and ~~struck~~.');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<del>struck</del>');
  });

  it('converts an unordered list, including nested items, to real <ul>/<li>', () => {
    const html = toAdoDescriptionHtml('- Slot A\n- Slot B\n  - Sub-slot B1\n- Slot C');
    expect(html).toContain('<ul>');
    expect((html.match(/<li>/g) ?? []).length).toBe(4);
  });

  it('converts a numbered list to real <ol>/<li>', () => {
    const html = toAdoDescriptionHtml('1. First\n2. Second\n3. Third');
    expect(html).toContain('<ol>');
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
  });

  it('emits no inline font-family or color -- ADO\'s own rich-text editor supplies its own defaults', () => {
    const html = toAdoDescriptionHtml('**Bold** text with a list:\n- one\n- two');
    expect(html).not.toMatch(/font-family/i);
    expect(html).not.toMatch(/color\s*:/i);
    expect(html).not.toContain('style=');
  });

  it('escapes a literal angle-bracket placeholder instead of swallowing it as a phantom HTML tag', () => {
    // Confirmed real content pattern in extracted spec text: "<TBD>" as a
    // not-yet-determined placeholder. CommonMark's raw-HTML rule would
    // otherwise treat "<TBD>" as an (unknown but syntactically valid) tag
    // and silently drop it from the rendered output.
    const html = toAdoDescriptionHtml('SBC Tiger - <TBD>, Zodiac - 12V');
    // Escaping `<` is the part THIS module is responsible for (CommonMark's
    // raw-HTML rule keys off it); marked's own text-node renderer escapes
    // the trailing `>` on top of that.
    expect(html).toContain('&lt;TBD&gt;');
  });

  it('treats a single newline as a line break (breaks: true), not a run-on sentence', () => {
    const html = toAdoDescriptionHtml('Line one.\nLine two.');
    expect(html).toContain('<br>');
  });

  it('passes a pre-rendered <table> block through as real HTML instead of escaping it to garbled text', () => {
    // Regression: ingestion's _table_to_html already produces trusted,
    // pre-escaped table HTML for ADO's rich-text field. Escaping its `<`
    // like ordinary text turned every table in every ADO work item into
    // an unreadable "&lt;table&gt;&lt;tr&gt;..." line.
    const description = 'Intro text.\n<table><tr><td>Cell A</td><td>Cell B</td></tr></table>';
    const html = toAdoDescriptionHtml(description);
    expect(html).toContain('<table><tr><td>Cell A</td><td>Cell B</td></tr></table>');
    expect(html).not.toContain('&lt;table&gt;');
  });

  it('still escapes a literal angle-bracket placeholder sitting next to a real <table> block', () => {
    const description = 'Value: <TBD>\n<table><tr><td>Cell A</td></tr></table>';
    const html = toAdoDescriptionHtml(description);
    expect(html).toContain('&lt;TBD&gt;');
    expect(html).toContain('<table><tr><td>Cell A</td></tr></table>');
  });

  it('passes a table using the real Phase 1 semantic shape (<thead>/<th>/colspan/<caption>) through completely intact', () => {
    // Regression: ingestion's _table_to_html is being rewritten away from
    // the old flat <table><tr><td> shape to real semantic HTML --
    // <thead>, <th>, colspan/rowspan, and <caption>. TABLE_BLOCK_PATTERN's
    // job is only to find the outer <table>...</table> boundaries so its
    // content bypasses angle-bracket escaping; it must not care what tags
    // live inside that boundary, or every one of these new tags would
    // regress into unreadable "&lt;thead&gt;" garbage in the real ADO item.
    const description =
      'Intro text.\n<table><caption>Slot allocation</caption><thead><tr><th colspan="2">Slot</th></tr></thead>' +
      '<tbody><tr><td>A</td><td>B</td></tr></tbody></table>';
    const html = toAdoDescriptionHtml(description);
    expect(html).toContain(
      '<table><caption>Slot allocation</caption><thead><tr><th colspan="2">Slot</th></tr></thead>' +
        '<tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
    );
    expect(html).not.toContain('&lt;thead&gt;');
    expect(html).not.toContain('&lt;th');
    expect(html).not.toContain('&lt;caption&gt;');
  });

  it('tolerates attributes on the opening <table> tag itself without breaking the block match', () => {
    // A bare `<table>` pattern (no `[^>]*`) would fail to match this block
    // at all, since the opening tag no longer matches literally -- the
    // whole block (including its genuinely-safe style attribute) would
    // fall through to the general escaping path and come out as garbled
    // "&lt;table style=..." text. `style="..."` here previews Phase 2
    // (out of scope for this task's content), but the REGEX must already
    // tolerate it since it's just "some attribute on the opening tag" as
    // far as matching is concerned.
    const description = '<table style="width:100%; border-collapse:collapse"><tr><td>Cell</td></tr></table>';
    const html = toAdoDescriptionHtml(description);
    expect(html).toContain('<table style="width:100%; border-collapse:collapse"><tr><td>Cell</td></tr></table>');
    expect(html).not.toContain('&lt;table');
  });

  it('still escapes a literal angle-bracket placeholder next to a semantically-rich table block', () => {
    // Same non-regression guarantee as the earlier bare-<table> version of
    // this test, re-proven against the new richer shape: the fix to
    // tolerate attributes/nested tags inside the trusted block must not
    // accidentally widen what counts as "inside the block" and start
    // swallowing unrelated prose <TBD> as HTML.
    const description =
      'Value: <TBD>\n<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>Cell A</td></tr></tbody></table>';
    const html = toAdoDescriptionHtml(description);
    expect(html).toContain('&lt;TBD&gt;');
    expect(html).toContain('<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>Cell A</td></tr></tbody></table>');
  });
});

describe('normalizeAdoStoredHtml', () => {
  it('reverses the exact 3 normalizations confirmed via a real ADO round-trip spike (table description)', () => {
    // Real captured data: docs/superpowers/specs/2026-08-12-table-fidelity-design.md's
    // Phase 0 findings -- one throwaway work item (ADO id 1195), a table
    // description sent through toAdoDescriptionHtml, read back via
    // GET /jobs/:id/validate, and diffed byte-for-byte against what was sent.
    const sentByUs =
      '<table><thead><tr><th colspan="3" style="text-align:center">Config</th></tr></thead><tbody><tr><td rowspan="2">GPU</td><td>60</td><td>3</td></tr><tr><td>85</td><td>2</td></tr></tbody></table>';
    const adoActuallyStored =
      '<table><thead><tr><th colspan=3 style="text-align:center;">Config</th></tr></thead><tbody><tr><td rowspan=2>GPU </td><td>60 </td><td>3 </td></tr><tr><td>85 </td><td>2 </td></tr></tbody></table>';
    expect(normalizeAdoStoredHtml(adoActuallyStored)).toBe(sentByUs);
  });

  it('reverses the same normalizations for a plain-prose description (not table-specific)', () => {
    // Real captured data from the SAME spike, a sibling item (ADO id 1194)
    // with no table at all -- proves ADO's trailing-space normalization is
    // a general write-time behavior, not something a table triggers.
    const sentByUs = '<p>ado spike fixture</p>\n';
    const adoActuallyStored = '<p>ado spike fixture </p>\n';
    expect(normalizeAdoStoredHtml(adoActuallyStored)).toBe(sentByUs);
  });

  it('is a no-op on HTML that already matches our own generator output exactly', () => {
    const html = '<p>Nothing to normalize here.</p>\n';
    expect(normalizeAdoStoredHtml(html)).toBe(html);
  });
});

describe('canonicalizeForCompare', () => {
  it('an ampersand in an href compares equal to its escaped form', () => {
    expect(canonicalizeForCompare('<a href="http://x/?a=1&b=2">l</a>')).toBe(canonicalizeForCompare('<a href="http://x/?a=1&amp;b=2">l</a>'));
    expect(canonicalizeForCompare('<a href="x?a=1&lt;2&gt;">l</a>')).toBe(canonicalizeForCompare('<a href="x?a=1&#60;2&#62;">l</a>'));
    expect(canonicalizeForCompare('<a href="x?a=1&amp;amp;b">l</a>')).not.toBe(canonicalizeForCompare('<a href="x?a=1&amp;b">l</a>'));
  });

  const same = (stored: string, expected: string) =>
    expect(canonicalizeForCompare(normalizeAdoStoredHtml(stored))).toBe(canonicalizeForCompare(expected));
  const differs = (stored: string, expected: string) =>
    expect(canonicalizeForCompare(normalizeAdoStoredHtml(stored))).not.toBe(canonicalizeForCompare(expected));

  it('treats ADO-encoded apostrophes and a trailing space before a closing tag as equal', () => {
    same('<p>The SRUs&#39; locations are listed: </p>', "<p>The SRUs' locations are listed:</p>");
    same('<p>It&apos;s &#x27;ok&#x27; &quot;q&quot;</p>', `<p>It's 'ok' "q"</p>`);
  });

  it('treats &nbsp; and U+00A0 as a space', () => {
    same('<p>a&nbsp;b</p>', '<p>a b</p>');
    same('<p>a\u00a0b</p>', '<p>a b</p>');
  });

  it('treats a trailing semicolon and spaces in style values as equal, on table and col', () => {
    same('<table style="width:100%;border-collapse:collapse;">', '<table style="width:100%; border-collapse:collapse">');
    same('<col style="width:48.872%;">', '<col style="width:48.872%">');
  });

  it('quotes bare attribute values and collapses whitespace between tags', () => {
    same('<td colspan=3>x</td>\n <td>y</td>', '<td colspan="3">x</td><td>y</td>');
  });

  it('decodes entities in a single pass (no double decoding of &amp;lt;)', () => {
    same('<p>a &amp; b &lt; c</p>', '<p>a & b < c</p>');
    differs('<p>&amp;lt;</p>', '<p><</p>');
  });

  it('still reports a changed word, number or punctuation', () => {
    differs('<p>The SRUs&#39; locations </p>', "<p>The SRU's locations</p>");
    differs('<p>Power 28 V </p>', '<p>Power 24 V</p>');
    differs('<p>locations: </p>', '<p>locations.</p>');
    differs('<p>a b</p>', '<p>ab</p>');
  });

  it('escaped markup text does not equal a real tag', () => {
    differs('<p>&lt;b&gt;x&lt;/b&gt;</p>', '<p><b>x</b></p>');
    same('<p>&lt;b&gt;x&lt;/b&gt;</p>', '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('a quote entity inside an attribute value does not break the comparison', () => {
    same('<p title="a &quot;q&quot; b" style="color:red;">x</p>', `<p title='a "q" b' style="color:red">x</p>`);
    differs('<p title="a &quot;q&quot; b">x</p>', '<p title="a q b">x</p>');
  });

  it('whitespace inside pre is significant, outside it is not', () => {
    same('<div>  a  <pre>x  y</pre>  b </div>', '<div>a<pre>x  y</pre>b</div>');
    differs('<pre>x  y</pre>', '<pre>x y</pre>');
    differs('<pre>x\ny</pre>', '<pre>x y</pre>');
  });

  it('tag and attribute case and single quotes compare equal', () => {
    same("<P CLASS='a'>x</P>", '<p class="a">x</p>');
    same("<TD ColSpan=3>x</TD>", '<td colspan="3">x</td>');
  });

  it('a description with 200k characters of < and no > canonicalises in under 500 ms', () => {
    const start = Date.now();
    canonicalizeForCompare('<'.repeat(200000));
    canonicalizeForCompare('<p ' + '<'.repeat(200000));
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('splitProposal', () => {
  const criteria = '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Given X, when Y, then Z</li></ul></div>';
  const needsInput = '<div data-r2a="needs-input"><p><b>Needs author input</b></p><p>Acceptance criteria were not proposed.</p></div>';

  it('returns the text untouched and no proposal when there is no generated section', () => {
    expect(splitProposal('The backplane shall support 7 slots.')).toEqual({ description: 'The backplane shall support 7 slots.', proposal: null });
  });

  it('separates a criteria section from the author text', () => {
    const result = splitProposal(`The backplane shall support 7 slots.\n${criteria}`);
    expect(result.description).toBe('The backplane shall support 7 slots.');
    expect(result.proposal).toEqual({ kind: 'criteria', html: criteria });
  });

  it('separates a needs-input section', () => {
    const result = splitProposal(`Text TBD\n${needsInput}`);
    expect(result.description).toBe('Text TBD');
    expect(result.proposal).toEqual({ kind: 'needs-input', html: needsInput });
  });

  it('removes every generated section, keeping the first as the proposal', () => {
    const result = splitProposal(`Text.\n${criteria}\n${needsInput}`);
    expect(result.description).toBe('Text.');
    expect(result.proposal?.kind).toBe('criteria');
  });

  // Pinned to the exact shape ingestion emits (ingestion/tests/test_acceptance_criteria.py has the same literals: change both together).
  it('parses the exact section shape ingestion emits', () => {
    const emitted =
      '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Given 7 slots, then all 7 are detected</li></ul><p><i>Assumptions</i></p><ul><li>Power is on</li></ul></div>';
    expect(splitProposal(`<p>The unit shall boot.</p>\n${emitted}`)).toEqual({ description: '<p>The unit shall boot.</p>', proposal: { kind: 'criteria', html: emitted } });
    const note =
      '<div data-r2a="needs-input"><p><b>Needs author input</b></p><p>Unresolved value(s) in this requirement: TBD. Acceptance criteria were not proposed.</p></div>';
    expect(splitProposal(`Text TBD\n${note}`)).toEqual({ description: 'Text TBD', proposal: { kind: 'needs-input', html: note } });
  });

  it('handles a description that is only the section', () => {
    expect(splitProposal(criteria)).toEqual({ description: '', proposal: { kind: 'criteria', html: criteria } });
  });

  it('leaves an author table untouched', () => {
    const table = '<table><tr><td>A</td></tr></table>';
    expect(splitProposal(`${table}\n${criteria}`).description).toBe(table);
  });
});

describe('composeAdoDescriptionHtml', () => {
  const criteria = '<div data-r2a="criteria"><p><b>Proposed acceptance criteria</b></p><ul><li>Given X</li></ul></div>';

  it('writes only the description when a proposal exists but was not accepted', () => {
    expect(composeAdoDescriptionHtml({ description: 'Text.', proposal: { kind: 'criteria', html: criteria } })).toBe(toAdoDescriptionHtml('Text.'));
    expect(composeAdoDescriptionHtml({ description: 'Text.', proposal: { kind: 'criteria', html: criteria }, proposalAccepted: false })).toBe(toAdoDescriptionHtml('Text.'));
  });

  it('appends the proposal as real HTML (not escaped) once accepted', () => {
    const html = composeAdoDescriptionHtml({ description: 'Text.', proposal: { kind: 'criteria', html: criteria }, proposalAccepted: true });
    expect(html).toBe(`${toAdoDescriptionHtml('Text.')}${criteria}`);
    expect(html).not.toContain('&lt;div');
  });

  it('never writes a needs-input note, even if flagged accepted', () => {
    const html = composeAdoDescriptionHtml({ description: 'Text.', proposal: { kind: 'needs-input', html: '<div data-r2a="needs-input"></div>' }, proposalAccepted: true });
    expect(html).toBe(toAdoDescriptionHtml('Text.'));
  });

  it('strips a generated section still inside the description of an older diff (no proposal field) and never writes it', () => {
    const html = composeAdoDescriptionHtml({ description: `Text.\n${criteria}` });
    expect(html).toBe(toAdoDescriptionHtml('Text.'));
    expect(html).not.toContain('data-r2a');
    expect(html).not.toContain('&lt;div');
  });
});

describe('composeAdoDescriptionHtml — text that only looks like a generated section (P9d review)', () => {
  const lookalike = 'Pasted: <div data-r2a="criteria"><p>x</p></div>';

  it('keeps it when the entry carries an explicit null proposal (a current diff with no proposal)', () => {
    expect(composeAdoDescriptionHtml({ description: lookalike, proposal: null })).toBe(toAdoDescriptionHtml(lookalike));
  });

  it('keeps it for a manually added entry', () => {
    expect(composeAdoDescriptionHtml({ description: lookalike, isManual: true })).toBe(toAdoDescriptionHtml(lookalike));
  });
});
