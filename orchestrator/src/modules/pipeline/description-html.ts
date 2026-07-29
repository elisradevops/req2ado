import { marked } from 'marked';

// CommonMark's raw-HTML-passthrough rule treats any `<` immediately
// followed by a letter as the start of a real HTML tag -- a literal "<TBD>"
// placeholder in extracted spec text (confirmed real content pattern in
// this domain) would otherwise silently vanish from the rendered output
// instead of showing as text. Pre-escaping every `<` before parsing closes
// that off while leaving every markdown construct we actually want
// (**bold**, ~~strike~~, - lists, 1. lists) untouched, since none of them
// use `<`.
function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;');
}

/**
 * Converts a work item description (plain prose, or markdown authored via
 * chat/edit-mode -- **bold**, *italic*, ~~strikethrough~~, `-`/`1.` lists
 * with nesting) into the HTML Azure DevOps's System.Description field
 * expects. Deliberately emits plain semantic tags (<p>, <ul>, <strong>, ...)
 * with NO inline font-family or color -- ADO's own work-item form already
 * applies its own default rich-text styling (font stack, foreground/
 * background, including dark mode) to whatever markup lives in this field;
 * baking in our own font/color would fight that instead of matching it.
 * `breaks: true` turns a single '\n' (not just a blank line) into a line
 * break, matching what a reviewer typing into a plain <textarea> expects.
 */
export function toAdoDescriptionHtml(text: string): string {
  return marked.parse(escapeAngleBrackets(text), { gfm: true, breaks: true, async: false }) as string;
}
