import type { LeftOut } from '../api/jobs';

/** " (pages 1–2)", " (page 1)", " (pages 1–5, 28–31)" (front matter and back matter are two spans, never one), or "" when no page is known. */
export function pagesPhrase(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const runs: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const page of [...sorted.slice(1), Number.NaN]) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    runs.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = previous = page;
  }
  return sorted.length === 1 ? ` (page ${sorted[0]})` : ` (pages ${runs.join(', ')})`;
}

/** The parts by the document's own words, quoted: “Revision History”, “Table of Contents” and 2 more. */
export function leftOutNames(leftOut: LeftOut, shown = 4): string {
  const names = leftOut.parts.map((part) => `“${part.text}”`);
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}
