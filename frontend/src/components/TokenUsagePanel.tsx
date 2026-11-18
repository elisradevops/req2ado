import type { TokenUsageRow } from '../api/jobs';

const fmt = (n: number): string => n.toLocaleString();

/** "propose_acceptance_criteria" -> "Propose acceptance criteria". */
function stageLabel(stage: string): string {
  const spaced = stage.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * What the model provider reported for the calls a job made, per pipeline stage. Shown on the Audit tab so a run's cost
 * can be read after the fact. Renders nothing when the job has no recorded usage (older jobs, or a proxy that reports none).
 */
export function TokenUsagePanel({ rows }: { rows: TokenUsageRow[] }): React.ReactElement | null {
  if (rows.length === 0) return null;
  // One line per stage: a job normally uses one model, but a per-job model change would otherwise split a stage across two lines.
  const byStage = new Map<string, TokenUsageRow>();
  for (const row of rows) {
    const sum = byStage.get(row.stage);
    byStage.set(
      row.stage,
      sum
        ? {
            ...sum,
            calls: sum.calls + row.calls,
            promptTokens: sum.promptTokens + row.promptTokens,
            completionTokens: sum.completionTokens + row.completionTokens,
            cachedTokens: sum.cachedTokens + row.cachedTokens,
            reasoningTokens: sum.reasoningTokens + row.reasoningTokens,
          }
        : row,
    );
  }
  const stages = [...byStage.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens));
  const total = stages.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      promptTokens: t.promptTokens + r.promptTokens,
      completionTokens: t.completionTokens + r.completionTokens,
      cachedTokens: t.cachedTokens + r.cachedTokens,
      reasoningTokens: t.reasoningTokens + r.reasoningTokens,
    }),
    { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
  );
  const showCached = total.cachedTokens > 0;
  const showReasoning = total.reasoningTokens > 0;
  const cell = 'px-2 py-1 text-right font-mono tabular-nums';
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-3">
      <span className="text-xs font-semibold text-ink-2">
        Tokens used — {fmt(total.promptTokens + total.completionTokens)} across {fmt(total.calls)} calls
      </span>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-xs text-ink-2">
          <thead>
            <tr className="border-b border-hairline text-ink-3">
              <th scope="col" className="px-2 py-1 text-left font-medium">Stage</th>
              <th scope="col" className={`${cell} font-medium`}>Calls</th>
              <th scope="col" className={`${cell} font-medium`}>Input</th>
              {showCached && <th scope="col" className={`${cell} font-medium`}>Cached</th>}
              <th scope="col" className={`${cell} font-medium`}>Output</th>
              {showReasoning && <th scope="col" className={`${cell} font-medium`}>Reasoning</th>}
            </tr>
          </thead>
          <tbody>
            {stages.map((row) => (
              <tr key={row.stage} className="border-b border-hairline last:border-b-0">
                <th scope="row" className="px-2 py-1 text-left font-normal">{stageLabel(row.stage)}</th>
                <td className={cell}>{fmt(row.calls)}</td>
                <td className={cell}>{fmt(row.promptTokens)}</td>
                {showCached && <td className={cell}>{fmt(row.cachedTokens)}</td>}
                <td className={cell}>{fmt(row.completionTokens)}</td>
                {showReasoning && <td className={cell}>{fmt(row.reasoningTokens)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-3">
        As reported by the model provider. Streamed calls, the document overview, image captions and embeddings are not counted yet.
      </p>
    </div>
  );
}
