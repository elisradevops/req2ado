import { NEUTRAL_FALLBACK_COLOR } from './neutralColor';

const TAG_COLORS: Record<string, string> = {
  functional: '#2563eb',
  non_functional: '#7c3aed',
  interface: '#0891b2',
  performance: '#ea580c',
  regulatory: '#b45309',
  safety: '#dc2626',
  security: '#be123c',
  operation: '#15803d',
  maintenance: '#4d7c0f',
  feature: '#0d9488',
  behavior: '#6366f1',
};

export function tagColor(tag: string): string {
  return TAG_COLORS[tag] ?? NEUTRAL_FALLBACK_COLOR;
}
