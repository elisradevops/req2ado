import { useEffect, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '../store/authStore';
import { useLlmConnectionStore } from '../store/llmConnectionStore';
import { getLlmConnection } from '../api/llmConnection';
import { useToast } from './ToastProvider';

// The Settings page must stay reachable even before the caller has
// configured an Open WebUI connection -- it's the only place that
// connection can be set, so exempting it is what makes the gate below
// resolvable rather than a dead end.
const LLM_GATE_EXEMPT_PATH = '/settings';

export function RouteGuard({ children }: { children: ReactElement }): ReactElement {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();
  const configured = useLlmConnectionStore((state) => state.configured);
  const setConfigured = useLlmConnectionStore((state) => state.setConfigured);
  const { showToast } = useToast();

  // Checked once per session (configured starts null, authStore.logout()
  // resets it back to null on sign-out) -- not on every navigation, since
  // Settings.tsx already flips this store directly the instant a save
  // succeeds (see its own handleSaveLlmConnection), so there's nothing
  // stale to re-poll for here.
  useEffect(() => {
    if (!isAuthenticated || configured !== null) return;
    getLlmConnection()
      .then((status) => setConfigured(status.configured))
      // Fail OPEN on a transient check failure -- a backend hiccup here
      // must never lock an otherwise-authenticated user out of the whole
      // app; the per-user LLM calls themselves will surface their own 401
      // if the connection genuinely isn't configured.
      .catch(() => setConfigured(true));
  }, [isAuthenticated, configured, setConfigured]);

  const isGateBlocking = configured === false && location.pathname !== LLM_GATE_EXEMPT_PATH;

  // Explains WHY this specific navigation attempt got redirected -- a bare
  // redirect with no explanation is the exact UX problem this gate exists
  // to fix. Effect-scoped (not called during render) and re-fires once per
  // distinct blocked pathname, not on every re-render of the same one.
  useEffect(() => {
    if (isGateBlocking) {
      showToast('Configure your Open WebUI connection before continuing.', 'info');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showToast is a stable context reference; including it would re-fire this on every ToastProvider re-render, not just on a genuinely new blocked path.
  }, [isGateBlocking, location.pathname]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (isGateBlocking) {
    return <Navigate to={LLM_GATE_EXEMPT_PATH} replace />;
  }

  return children;
}
