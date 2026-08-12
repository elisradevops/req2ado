import { normalizeAdoStoredHtml, toAdoDescriptionHtml } from '../src/modules/pipeline/description-html';

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
