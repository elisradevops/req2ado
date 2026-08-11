// orchestrator/scripts/purge-user-data.ts
/**
 * Admin/CLI remediation for a deleted-and-recreated ADO account whose new
 * session resolves to the same descriptor-derived userId as the old one
 * (see docs/runbook.md's "Purging a user's KB/PAT-vault data after an ADO
 * account reset"). Both the KB vector store (ingestion/app/kb/
 * kb_vector_store.py, collection keyed by sha256(userId)) and the encrypted
 * PAT vault (credential-vault.service.ts, row keyed by `user:<userId>`) are
 * durable by design and have no automated cleanup path -- this is the one
 * deliberately manual, deliberately non-silent way to reclaim them.
 *
 * Never wired into any request path -- run by hand, same convention as
 * scripts/run-load-test.sh (thin bootstrap wiring real dependencies, no
 * automated test; see pipeline-worker.main.ts's own precedent for this).
 *
 * Usage: npx ts-node scripts/purge-user-data.ts <userId> [--purge-jobs]
 */
import { PrismaClient } from '@prisma/client';
import { configSchema } from '../src/config/config.schema';
import { CredentialVaultService, userOwnerKey, type CredentialKind } from '../src/modules/auth/credential-vault.service';
import { IngestionHttpClient } from '../src/modules/pipeline/ingestion-http.client';

async function purgeUserJobs(prisma: PrismaClient, userId: string): Promise<number> {
  const candidates = await prisma.job.findMany({ where: { userId }, select: { id: true } });
  if (candidates.length === 0) return 0;
  const jobIds = candidates.map((job) => job.id);

  // Same FK-ordering constraint as job-retention.service.ts's sweep(): every
  // child table has an ON DELETE RESTRICT FK to Job, so children must be
  // deleted before the parent Job row. Unlike that age-based sweep, this is
  // a deliberate one-shot admin action -- a failure here must NOT be
  // swallowed (see main()'s try/catch), so the operator knows immediately
  // whether the purge actually completed.
  await prisma.$transaction([
    prisma.chatMessage.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.auditEntry.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.dedupSkipAudit.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.createdItemMapping.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.jobSourceFile.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.jobFigureFile.deleteMany({ where: { jobId: { in: jobIds } } }),
    prisma.job.deleteMany({ where: { id: { in: jobIds } } }),
  ]);
  return jobIds.length;
}

async function main(): Promise<void> {
  const [userId, ...flags] = process.argv.slice(2);
  if (!userId) {
    process.stderr.write('Usage: npx ts-node scripts/purge-user-data.ts <userId> [--purge-jobs]\n');
    process.exit(1);
  }
  const purgeJobs = flags.includes('--purge-jobs');

  const config = configSchema.parse(process.env);
  const prisma = new PrismaClient();
  const credentialVault = new CredentialVaultService(prisma, config.CREDENTIAL_ENC_KEY, config.CREDENTIAL_ENC_KEY_PREVIOUS);
  const ingestionClient = new IngestionHttpClient(config.INGESTION_BASE_URL);

  process.stdout.write(`Purging data for userId=${userId} (purgeJobs=${purgeJobs})\n`);

  // Purges every credential kind under this userId's ownerKey, not just
  // 'ado_pat' -- CredentialKind allows any of the three under any ownerKey,
  // so a defensive purge covers 'sharepoint_token'/'llm_api_key' too in
  // case either is ever stored per-user in the future (today, in practice,
  // neither is: sharepoint_token is always stored under SHARED_OWNER_KEY,
  // and llm_api_key has no real per-user call site at all).
  const credentialKinds: CredentialKind[] = ['ado_pat', 'sharepoint_token', 'llm_api_key'];
  for (const kind of credentialKinds) {
    await credentialVault.delete(userOwnerKey(userId), kind);
  }
  process.stdout.write(`Purged PAT vault rows (${credentialKinds.join(', ')}): done\n`);

  await ingestionClient.purgeUserKb(userId);
  process.stdout.write('Purged KB vector-store collection: done\n');

  if (purgeJobs) {
    const count = await purgeUserJobs(prisma, userId);
    process.stdout.write(`Purged job rows: ${count}\n`);
  } else {
    process.stdout.write('Skipped job-row purge (pass --purge-jobs to include it)\n');
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  // Deliberately not silent -- this is a one-shot manual remediation, not a
  // best-effort background path. A partial purge (e.g. PAT deleted, KB
  // purge failed) must be visible to the operator, not swallowed.
  process.stderr.write(`purge-user-data failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
