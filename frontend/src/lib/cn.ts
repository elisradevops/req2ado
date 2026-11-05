import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The type-scale rungs declared in index.css (section 13) are font SIZES.
// tailwind-merge only knows Tailwind's own size names, so it read
// `text-micro` / `text-metric` as colours and dropped them whenever a
// `text-ink-3` / `text-ok` came later (StatTile labels rendered 16px, values
// shrank under a tone colour). Keep this list in step with that section.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'meta', 'title', 'display', 'metric'] }],
    },
  },
});

/**
 * clsx + tailwind-merge: when two className sources set the same utility
 * (e.g. a component's own `overflow-hidden` and a caller's `overflow-x-auto`
 * override), plain concatenation leaves both classes in the string and CSS
 * source order — not intent — decides which one wins. twMerge resolves
 * that conflict deterministically: the later class always wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
