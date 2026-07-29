import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '../ui/Button';

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
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
          <TriangleAlert className="h-8 w-8 text-danger" />
          <h1 className="text-lg font-semibold">Something went wrong.</h1>
          <p className="text-sm text-ink-3">An unexpected error occurred. Reloading usually fixes it.</p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
