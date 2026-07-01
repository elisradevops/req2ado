import type { JSX } from 'react';
import { AppThemeProvider } from './theme/AppThemeProvider.js';
import { Login } from './pages/Login.js';

export function App(): JSX.Element {
  return (
    <AppThemeProvider>
      <Login />
    </AppThemeProvider>
  );
}
