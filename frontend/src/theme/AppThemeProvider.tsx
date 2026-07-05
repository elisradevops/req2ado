import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';
import type { JSX, ReactNode } from 'react';
import { themeTokens } from './tokens.js';

const theme = createTheme({
  palette: {
    primary: { main: themeTokens.color.primary, dark: themeTokens.color.primaryDark, light: themeTokens.color.primaryLight },
    background: { default: themeTokens.color.background, paper: themeTokens.color.surface },
    text: { primary: themeTokens.color.textPrimary, secondary: themeTokens.color.textSecondary },
    error: { main: themeTokens.color.danger },
    success: { main: themeTokens.color.success },
    info: { main: themeTokens.color.info },
  },
  shape: { borderRadius: themeTokens.radius.md },
  typography: {
    fontFamily: themeTokens.font.family,
    h5: { fontWeight: 700 },
    h6: { fontWeight: 700 },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: themeTokens.radius.sm, textTransform: 'none', fontWeight: 600 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: { borderRadius: themeTokens.radius.md },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: { borderRadius: themeTokens.radius.md, boxShadow: themeTokens.shadow.medium },
      },
    },
  },
});

export function AppThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
