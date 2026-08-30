// Tailwind slate-500 -- the shared "no real category/type match" fallback
// color used by every per-key color lookup in this app (tag, work-item
// type, file type), so a new unmapped key always renders the same neutral
// gray everywhere instead of drifting per call site.
export const NEUTRAL_FALLBACK_COLOR = '#64748B';
