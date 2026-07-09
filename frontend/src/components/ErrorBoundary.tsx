import { Component, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box p={4}>
          <Typography variant="h5">Something went wrong.</Typography>
          <Typography>Reload the page to continue.</Typography>
        </Box>
      );
    }
    return this.props.children;
  }
}
