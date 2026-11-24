import type { LeftOut } from '../api/jobs';

/** " (pages 1–2)", " (page 1)", or "" when no page is known. */
export function pagesPhrase(pages: number[]): string {
  if (pages.length === 0) return '';
  const low = Math.min(...pages);
  const high = Math.max(...pages);
  return low === high ? ` (page ${low})` : ` (pages ${low}–${high})`;
}

/** The parts by the document's own words, quoted: “Revision History”, “Table of Contents” and 2 more. */
export function leftOutNames(leftOut: LeftOut, shown = 4): string {
  const names = leftOut.parts.map((part) => `“${part.text}”`);
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}
