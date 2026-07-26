// Shared candidate list for the Custom.CustomerId-style field an ADO
// process template might expose on a work-item type -- previously
// duplicated verbatim in jobs.service.ts (confirm-time resolution) and
// pipeline.worker.ts (dry-run-time resolution for crossJob trace links).
// Two independent copies could silently drift if one were edited without
// the other, making confirm-time and dry-run-time resolution disagree on
// which field a node's customer ID actually lands on.
export const DEFAULT_CUSTOMER_ID_FIELD_CANDIDATES = ['Custom.CustomerId', 'Custom.CustomerRequirementId', 'Custom.CustomerID'];
