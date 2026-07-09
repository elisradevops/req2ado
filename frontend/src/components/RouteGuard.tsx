import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useIsAuthenticated } from '../store/authStore';

export function RouteGuard({ children }: { children: ReactElement }): ReactElement {
  const isAuthenticated = useIsAuthenticated();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
