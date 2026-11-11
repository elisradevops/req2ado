// What one batch may hold. The server enforces the same numbers (kb-ingest-batch.service.ts): a file over the size limit
// would be refused by ingestion anyway, and the page says so up front instead of queuing it to fail.
export const KB_BATCH_MAX_FILES = 200;
export const KB_MAX_FILE_BYTES = 50 * 1024 * 1024;
// From this many files the dialog reminds the user that it runs in the background and may take a while.
export const KB_BATCH_LONG_RUN_FILES = 25;
// From this many Reference files the dialog warns about the token cost every job will pay.
export const KB_BATCH_MANY_REFERENCE_FILES = 5;
