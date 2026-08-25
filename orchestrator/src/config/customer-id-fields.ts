// Shared candidate list for the Custom.CustomerId-style field an ADO
// process template might expose on a work-item type -- previously
// duplicated verbatim in jobs.service.ts (confirm-time resolution) and
// pipeline.worker.ts (dry-run-time resolution for crossJob trace links).
// Two independent copies could silently drift if one were edited without
// the other, making confirm-time and dry-run-time resolution disagree on
// which field a node's customer ID actually lands on.
//
// 'System.CustomerId' is listed first (resolution takes the first available
// match): docgen-data-provider-package -- already integrated against this
// org's real ADO tenant -- reads Customer ID from exactly this reference
// name (TicketsDataProvider.ts: wi.fields['System.CustomerId']), so it is
// real-environment evidence, not a guess like the three Custom.* candidates
// that follow it.
export const DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES = [
  'System.CustomerId',
  'Custom.CustomerId',
  'Custom.CustomerRequirementId',
  'Custom.CustomerID',
];
