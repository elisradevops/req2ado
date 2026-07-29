import { toAdoDescriptionHtml } from '../src/modules/pipeline/description-html';

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
});
