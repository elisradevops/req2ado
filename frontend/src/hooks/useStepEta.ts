import { useRef } from 'react';
import { observeStep, stepEta, type StepEta, type StepEtaState } from '../utils/stepEta';

// Folds the current step's progress into a countdown (see utils/stepEta.ts). `stepKey` names the step
// (its unit basis); a new key, or progress going backwards, starts a fresh estimate. Returns null when
// there is no step to estimate. Nothing is persisted, so a reload shows "estimating" again until the
// page has watched enough of the step itself -- honest, since it did not see the earlier progress.
//
// The state lives in a ref updated during render, which is safe here because `observeStep` is
// idempotent: re-rendering with the same observation returns the same state.
export function useStepEta(
  stepKey: string | undefined,
  done: number | undefined,
  total: number | undefined,
  now: number,
): StepEta | null {
  const stateRef = useRef<StepEtaState | null>(null);
  if (stepKey === undefined || done === undefined || !total) {
    stateRef.current = null;
    return null;
  }
  stateRef.current = observeStep(stateRef.current, stepKey, done, total, now);
  return stepEta(stateRef.current, done, total, now);
}
