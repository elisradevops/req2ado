import { Link, useLocation } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { PageHeader } from '../ui/PageHeader';

// DESIGN.md §12: an error state says what happened and invites the next action; §4: the page title is the one `text-display`.
export function NotFound(): React.ReactElement {
  usePageTitle('Page not found');
  const { pathname } = useLocation();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Page not found"
        description={
          <>
            Nothing lives at <span className="font-mono">{pathname}</span>.
          </>
        }
      />
      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/jobs" className="font-medium text-accent-ink hover:underline">
          Go to jobs
        </Link>
        <Link to="/knowledge-base" className="font-medium text-accent-ink hover:underline">
          Open the knowledge base
        </Link>
      </div>
    </div>
  );
}
