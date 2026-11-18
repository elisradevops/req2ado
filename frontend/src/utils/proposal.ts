// The values a "Needs author input" note names as missing. Ingestion wraps each one in `<span data-missing-value="…">`; an older job has only the
// sentence "Unresolved value(s) in this requirement: TBD, XXX.", which is read as a fallback. Read as text, never as markup.
export function missingValuesOf(html: string | null | undefined): string[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const marked = Array.from(doc.querySelectorAll('[data-missing-value]')).map((el) => (el.textContent ?? '').trim());
  if (marked.some(Boolean)) return Array.from(new Set(marked.filter(Boolean)));
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ');
  const match = text.match(/Unresolved value\(s\) in this requirement:\s*(.+?)\.\s*(?:Acceptance criteria|$)/);
  if (!match) return [];
  return Array.from(new Set(match[1].split(',').map((part) => part.trim()).filter(Boolean)));
}
