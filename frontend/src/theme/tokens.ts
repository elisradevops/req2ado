/**
 * Design tokens shared across the app — mirrors the token-based approach
 * used by docgen-frontend's src/theme/tokens.js and
 * ado-hierarchy-viewer/frontend's MUI theme. Never inline hex colors in
 * components; import from here.
 */
export const themeTokens = {
  color: {
    primary: '#2451B7',
    primaryDark: '#173a8a',
    surface: '#FFFFFF',
    surfaceAlt: '#F4F6FB',
    border: '#D8DEE9',
    textPrimary: '#1B2430',
    textSecondary: '#5B6472',
    danger: '#C4314B',
    success: '#2E7D32',
  },
  radius: { sm: 4, md: 8, lg: 16 },
  spacing: (multiplier: number): number => multiplier * 8,
} as const;
