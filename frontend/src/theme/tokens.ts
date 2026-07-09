/**
 * Design tokens shared across the app — matches docgen-frontend's actual
 * theme (src/theme/tokens.js: primary #1B458F, Inter font, 8px grid, 10px
 * card radius) per docs/architecture.md's "DocGen visual language" decision.
 * The mono font is req2ado-specific: BASELINE mode's core value is verbatim
 * fidelity, so technical artifacts (ADO ids, source hashes) get a distinct
 * face that reads as data, not prose. Never inline hex colors in
 * components; import from here.
 */
export const themeTokens = {
  color: {
    primary: '#1B458F',
    primaryDark: '#102951',
    primaryLight: '#3B60C0',
    accent: '#FDE134',
    railBackground: '#0F1B3D',
    liveAccent: '#06B6D4',
    background: '#f8fafc',
    surface: '#FFFFFF',
    surfaceAlt: '#F4F6FB',
    border: '#D8DEE9',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    danger: '#D1434B',
    success: '#15803d',
    info: '#2563eb',
    warning: '#B45309',
  },
  font: {
    family: "'Inter', 'Roboto', 'Helvetica', 'Arial', sans-serif",
    mono: "ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  },
  radius: { sm: 6, md: 10, lg: 16 },
  shadow: { medium: '0px 6px 20px rgba(15, 23, 42, 0.12)' },
  spacing: (multiplier: number): number => multiplier * 8,
} as const;
