-- AuditEntry and DedupSkipAudit were the only two Job-child tables with no
-- index on jobId at all, unlike JobEvent's own @@index([jobId, createdAt]).
-- Both are real, live query patterns: jobs.service.ts's getAuditLog/
-- getDedupSkipAudit (findMany where jobId = id) and job-retention.service.ts's
-- cleanup sweep (deleteMany where jobId IN (...)) both seq-scan today.

CREATE INDEX "AuditEntry_jobId_idx" ON "AuditEntry"("jobId");

CREATE INDEX "DedupSkipAudit_jobId_idx" ON "DedupSkipAudit"("jobId");
