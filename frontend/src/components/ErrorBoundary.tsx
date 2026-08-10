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
          {/* DESIGN.md §12: error copy states cause then remedy, never
              "Something went wrong" -- a render-time error genuinely has no
              specific cause available here (React only reports that
              rendering threw, not why), so the honest version of "cause"
              is naming what's known: this page hit an error while
              rendering, and reloading is the real remedy. */}
          <h1 className="text-lg font-semibold">This page hit an error while rendering</h1>
          <p className="text-sm text-ink-3">Reloading usually fixes it. If it keeps happening, check the browser console for the real error.</p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
