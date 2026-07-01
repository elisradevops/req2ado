import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';
import type { JSX, ReactNode } from 'react';
import { themeTokens } from './tokens.js';

const theme = createTheme({
  palette: {
    primary: { main: themeTokens.color.primary, dark: themeTokens.color.primaryDark },
    background: { default: themeTokens.color.surfaceAlt, paper: themeTokens.color.surface },
    text: { primary: themeTokens.color.textPrimary, secondary: themeTokens.color.textSecondary },
    error: { main: themeTokens.color.danger },
    success: { main: themeTokens.color.success },
  },
  shape: { borderRadius: themeTokens.radius.md },
});

export function AppThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
