import { useCallback, useEffect, useRef, useState } from 'react';
import { checkRewrite, type RewriteComparison, type RewriteWarning } from '../api/chat';

// An assistant's suggested rewrite and the check that judges it against the current item (DESIGN.md §11.4.6). Owned by the item dialog, not by the
// chat panel: the panel unmounts with its drawer, and a suggestion must survive that, and the reviewer stepping through the dialog.

export interface Proposal {
  proposedTitle: string | null;
  proposedDescription: string | null;
}

// The prediction is a model call and can be slow (the server stops waiting for it at 60 s). Past this limit the proposal can be applied
// without it, but the check keeps listening: an answer that arrives later still updates it. The warnings do not wait for the prediction
// (they need no model), and a warning still asks for confirmation.
export const CHECK_TIMEOUT_MS = 75_000;
// The scorer is a sampled model: a difference this small is noise, not a better or worse rewrite.
export const NOISE_BAND = 5;

/**
 * What is known about ONE proposal. `warnings` come back at once; `prediction` (the original and the proposal scored together)
 * takes a model call. Kept with the proposal it belongs to, so a state left over from an earlier proposal is never read for a newer one.
 */
export interface ProposalCheck {
  proposal: Proposal;
  warnings: { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; items: RewriteWarning[] };
  // `late`: the limit passed without an answer; Accept is open, the answer may still come.
  prediction: { status: 'loading' } | { status: 'late' } | { status: 'unavailable' } | { status: 'ready'; data: RewriteComparison };
}

export interface ProposalReviewState {
  proposal: Proposal | null;
  setProposal: (proposal: Proposal | null) => void;
  // Only a Requirement's description is scored: for anything else (and a title-only proposal) there is no check.
  checking: boolean;
  check: ProposalCheck | null;
  // The warnings or the prediction are still on their way.
  loading: boolean;
  warningItems: RewriteWarning[];
  comparison: RewriteComparison | null;
  // Nothing could be checked at all ("unchecked" is not "fine").
  notChecked: boolean;
  predictingSeconds: number;
  // Applying asks first when the check predicts a lower score, found something that probably lost content, or could not check at all.
  needsConfirmation: boolean;
}

/**
 * @param checkedKind whether the item is a Requirement (an Epic or a Feature has no score, so nothing to predict).
 * The proposal is cleared when the job or the item changes, so a suggestion can never be applied onto another item.
 */
export function useProposalReview(jobId: string, localId: string, checkedKind: boolean): ProposalReviewState {
  const [proposal, setProposalState] = useState<Proposal | null>(null);
  const [checkState, setCheckState] = useState<ProposalCheck | null>(null);
  const [predictingSeconds, setPredictingSeconds] = useState(0);
  const checkRequestRef = useRef(0);

  const setProposal = useCallback((next: Proposal | null) => setProposalState(next), []);

  useEffect(() => {
    setProposalState(null);
  }, [jobId, localId]);

  // A proposal with a description is checked before it can be applied: the warnings come back at once (no model), the predicted score
  // (the original and the proposal scored together) when the model has answered. A result that arrives after the proposal or the item
  // changed is discarded.
  useEffect(() => {
    const request = ++checkRequestRef.current;
    if (!checkedKind || !proposal?.proposedDescription) {
      setCheckState(null);
      return;
    }
    const target = { proposedTitle: proposal.proposedTitle, proposedDescription: proposal.proposedDescription };
    const fresh = () => request === checkRequestRef.current;
    const update = (patch: Partial<Pick<ProposalCheck, 'warnings' | 'prediction'>>) =>
      setCheckState((prev) => (prev && prev.proposal === proposal ? { ...prev, ...patch } : prev));
    setCheckState({ proposal, warnings: { status: 'loading' }, prediction: { status: 'loading' } });

    checkRewrite(jobId, localId, { ...target, warningsOnly: true })
      .then((data) => {
        if (fresh()) update(data && Array.isArray(data.warnings) ? { warnings: { status: 'ready', items: data.warnings } } : { warnings: { status: 'unavailable' } });
      })
      .catch(() => {
        if (fresh()) update({ warnings: { status: 'unavailable' } });
      });

    // Past the limit Accept opens up (`late`), but the request is not abandoned: an answer that comes later still updates the check.
    setPredictingSeconds(0);
    const startedAt = Date.now();
    const ticker = setInterval(() => setPredictingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    const limit = setTimeout(
      () => setCheckState((prev) => (prev && prev.proposal === proposal && prev.prediction.status === 'loading' ? { ...prev, prediction: { status: 'late' } } : prev)),
      CHECK_TIMEOUT_MS,
    );
    const settle = () => {
      clearInterval(ticker);
      clearTimeout(limit);
    };
    checkRewrite(jobId, localId, target)
      .then((data) => {
        if (!fresh()) return;
        if (data && Array.isArray(data.warnings)) update({ prediction: { status: 'ready', data }, warnings: { status: 'ready', items: data.warnings } });
        else update({ prediction: { status: 'unavailable' } });
      })
      .catch(() => {
        if (fresh()) update({ prediction: { status: 'unavailable' } });
      })
      .finally(settle);
    return settle;
  }, [proposal, jobId, localId, checkedKind]);

  // Only the state that belongs to the proposal on screen counts (the render before the effect runs would otherwise see the last one's).
  const check = checkState && checkState.proposal === proposal ? checkState : null;
  const checking = checkedKind && !!proposal?.proposedDescription;
  const loading = checking && (!check || check.warnings.status === 'loading' || check.prediction.status === 'loading');
  const warningItems = check?.warnings.status === 'ready' ? check.warnings.items : [];
  const comparison = check?.prediction.status === 'ready' ? check.prediction.data : null;
  const notChecked = checking && check?.warnings.status === 'unavailable';
  const needsConfirmation =
    !loading && (notChecked || warningItems.some((w) => w.severity === 'high') || (comparison?.delta != null && comparison.delta < -NOISE_BAND));

  return { proposal, setProposal, checking, check, loading, warningItems, comparison, notChecked, predictingSeconds, needsConfirmation };
}
