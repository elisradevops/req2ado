import type { JSX, ReactNode } from 'react';
import { AppBar, Box, Container, Toolbar, Typography } from '@mui/material';

export interface AppShellProps {
  children: ReactNode;
}

/** Shared chrome for authenticated pages — matches DocGen's AppBar-only layout (no sidebar). */
export function AppShell({ children }: AppShellProps): JSX.Element {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" elevation={0} color="primary">
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ letterSpacing: 0.5 }}>
            req2ado
          </Typography>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ flexGrow: 1, py: 6 }}>
        {children}
      </Container>
    </Box>
  );
}
