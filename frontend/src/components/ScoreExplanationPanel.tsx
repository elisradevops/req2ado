import { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { ScoreExplanation } from '../api/jobs';
import { Button } from '../ui/Button';

type State = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: ScoreExplanation };

/**
 * "Why this score?": the reason for each low category of an item, asked for on demand (one short model call). The explanation describes ONE
 * item at ONE score, so it is forgotten when `resetKey` changes, and an answer that arrives after that is not shown.
 */
export function ScoreExplanationPanel({ load, resetKey }: { load: () => Promise<ScoreExplanation>; resetKey: string }): React.ReactElement {
  const [state, setState] = useState<State>({ status: 'idle' });
  const [seconds, setSeconds] = useState(0);
  const requestRef = useRef(0);

  // The model can take a minute or two; the count is the evidence that something is happening. It starts again with each try: `ask` zeroes
  // it in the same render that starts loading (an effect would let one frame show the last try's count).
  const loading = state.status === 'loading';
  useEffect(() => {
    if (!loading) return undefined;
    const startedAt = Date.now();
    const ticker = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(ticker);
  }, [loading]);

  useEffect(() => {
    requestRef.current += 1;
    setState({ status: 'idle' });
  }, [resetKey]);

  function ask(): void {
    const request = ++requestRef.current;
    setSeconds(0);
    setState({ status: 'loading' });
    load()
      .then((data) => {
        if (request === requestRef.current) setState(data && Array.isArray(data.explanations) ? { status: 'ready', data } : { status: 'error' });
      })
      .catch(() => {
        if (request === requestRef.current) setState({ status: 'error' });
      });
  }

  if (state.status === 'ready') {
    return (
      <div className="flex flex-col gap-1.5 rounded-sm border border-hairline bg-surface p-2.5">
        <p className="text-micro text-ink-3">
          {state.data.basis === 'knowledge_base' ? 'Based on your knowledge base.' : 'Based on the built-in rubric (your knowledge base has none).'}
        </p>
        {state.data.explanations.map((e) => (
          <div key={e.category} className="flex flex-col gap-0.5">
            <p className="flex items-baseline gap-2 text-sm">
              <span className="font-semibold text-ink-1">{e.category}</span>
              {e.score !== null && <span className="font-mono text-xs text-ink-2">{e.score}</span>}
            </p>
            <p className="text-sm text-ink-1">{e.reason ?? <span className="text-ink-3">No reason was given for this category.</span>}</p>
            {e.passCondition && <p className="text-micro text-ink-3">Held to: {e.passCondition}</p>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={ask} loading={state.status === 'loading'} disabled={state.status === 'loading'}>
        {state.status !== 'loading' && <HelpCircle className="h-3 w-3" />}
        {state.status === 'loading' ? (seconds > 0 ? `Explaining… ${seconds} s` : 'Explaining…') : state.status === 'error' ? 'Try again' : 'Why this score?'}
      </Button>
      {state.status === 'error' && <p className="text-xs text-danger-ink">Could not explain this score. The model can be slow at times; try again.</p>}
    </div>
  );
}
