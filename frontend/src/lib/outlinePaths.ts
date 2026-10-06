import type { MapItem } from '../api/liveTypes';

export const PATH_SEPARATOR = ' › ';

/**
 * Where each outline item sits: the headings above it, outermost first, joined
 * with " › " ("Subsystem 1 › Function 1.2"). The map lists items in document
 * order with a depth, so an item's ancestors are the nearest earlier items with
 * a smaller depth. A top-level item has no path and is absent from the result.
 */
export function buildOutlinePaths(items: readonly MapItem[]): Map<string, string> {
  const paths = new Map<string, string>();
  const trail: { depth: number; title: string }[] = [];
  for (const item of items) {
    while (trail.length > 0 && trail[trail.length - 1].depth >= item.depth) trail.pop();
    if (trail.length > 0) paths.set(item.ref, trail.map((entry) => entry.title).join(PATH_SEPARATOR));
    trail.push({ depth: item.depth, title: item.title });
  }
  return paths;
}
