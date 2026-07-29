import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
