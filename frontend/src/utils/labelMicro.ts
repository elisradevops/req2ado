// The small section-label treatment repeated verbatim across ~10
// components (StatTile, ModeCards, AddChildForm, ChatPanel, DestinationBar,
// NodeDetailPanel, DiffTree, and every table header cell) -- one source so
// a future tweak to this look lands everywhere at once. Sentence case on
// purpose (DESIGN.md section 4): capitals are kept for enum values and
// identifiers, so a label never reads in the same voice as the data under it.
export const LABEL_MICRO = 'text-meta font-semibold tracking-normal text-ink-3';
