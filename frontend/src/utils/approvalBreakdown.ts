// How the items that will be written were reviewed, for the final write summary (P17d). UI session only: nothing here is stored or
// sent, so a reload starts every approved item as "reviewed earlier". Which items will be written comes from the server's preview.
export type ApprovalMethod = 'single' | 'bulk';

export interface ApprovalBreakdown {
  edited: number;
  single: number;
  // Approved in bulk without being looked at, and the bulk items the reviewer did look at in the spot-check.
  bulk: number;
  bulkSpotChecked: number;
  // Reviewed, but not in this page session.
  earlier: number;
  notReviewed: number;
}

export function approvalBreakdown({
  createdLocalIds,
  reviewedIds,
  methods,
  spotCheckedIds,
  editedIds,
}: {
  createdLocalIds: string[];
  reviewedIds: Set<string>;
  methods: Map<string, ApprovalMethod>;
  spotCheckedIds: Set<string>;
  editedIds: Set<string>;
}): ApprovalBreakdown {
  const result: ApprovalBreakdown = { edited: 0, single: 0, bulk: 0, bulkSpotChecked: 0, earlier: 0, notReviewed: 0 };
  for (const localId of createdLocalIds) {
    if (!reviewedIds.has(localId)) {
      result.notReviewed += 1;
      continue;
    }
    // An edit changes the text the reviewer approved, so it is counted as an edit however it was then approved.
    if (editedIds.has(localId)) result.edited += 1;
    else if (methods.get(localId) === 'single') result.single += 1;
    else if (methods.get(localId) === 'bulk') {
      if (spotCheckedIds.has(localId)) result.bulkSpotChecked += 1;
      else result.bulk += 1;
    } else result.earlier += 1;
  }
  return result;
}
