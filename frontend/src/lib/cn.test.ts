import { describe, it, expect } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('lets the later class win for a plain conflict', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  // The type-scale tokens (index.css section 13) are font SIZES, not colours.
  // Without telling tailwind-merge so, `text-ink-3` / `text-ok` look like a
  // later conflicting `text-*` and silently delete the size.
  it.each(['text-micro', 'text-meta', 'text-title', 'text-display', 'text-metric'])(
    'keeps the %s size next to a text colour',
    (size) => {
      expect(cn(size, 'text-ink-3')).toBe(`${size} text-ink-3`);
      expect(cn(size, 'text-ok')).toBe(`${size} text-ok`);
    },
  );

  it('still lets a later size override an earlier one', () => {
    expect(cn('text-micro', 'text-xs')).toBe('text-xs');
    expect(cn('text-xs', 'text-metric')).toBe('text-metric');
  });

  it('keeps a colour next to a size regardless of order', () => {
    expect(cn('text-ink-3', 'text-micro')).toBe('text-ink-3 text-micro');
  });
});
