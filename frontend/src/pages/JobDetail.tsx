import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import {
  getJob,
  confirmJob,
  getAudit,
  editDiffEntry,
  setDiffEntryExcluded,
  addDiffEntry,
  rejectJob,
  getSummary,
  type AuditEntry,
  type JobSummaryReport,
} from '../api/jobs';
import { subscribeToJobEvents, type JobStage, type NarrationEvent } from '../api/events';
import { loadRuntimeConfig } from '../api/config';
import { useOrgUrl, usePat } from '../store/authStore';
import { StatusChip } from '../components/StatusChip';
import { ProgressBanner } from '../components/ProgressBanner';
import { DiffTree, type DryRunDiffEntry } from '../components/DiffTree';
import { NodeDetailPanel } from '../components/NodeDetailPanel';
import { AddChildForm } from '../components/AddChildForm';
import type { KbCitation } from '../components/KbCitationChips';

export function JobDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const orgUrl = useOrgUrl();
  const pat = usePat();
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [kbCitations, setKbCitations] = useState<KbCitation[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [diff, setDiff] = useState<DryRunDiffEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<JobStage | null>(null);
  const [narrations, setNarrations] = useState<NarrationEvent[]>([]);
  const [tab, setTab] = useState<'tree' | 'audit'>('tree');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<JobSummaryReport | null>(null);
  // Real job creation time from the server -- NOT page-load/mount time, so
  // a refresh mid-run shows the actual elapsed duration instead of
  // resetting to zero. null until the job fetch below resolves.
  const [startedAt, setStartedAt] = useState<string | null>(null);
  // Confirm and Reject are mutually exclusive, job-terminating writes -- a
  // synchronous ref guard (state alone is too slow: clicks before the first
  // re-render read the stale false from closure) prevents a double-submit
  // race between the two buttons or a double-click on either.
  const isMutatingRef = useRef(false);
  const [isMutating, setIsMutating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getJob(id).then((job) => {
      if (cancelled) return;
      setStatus(job.status);
      setMode(job.mode);
      setKbCitations(job.kbCitations ?? []);
      setWarnings(job.warnings ?? []);
      setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
      setStartedAt(job.createdAt);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || status !== 'diff_ready') return;
    let cancelled = false;
    getSummary(id).then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [id, status]);

  useEffect(() => {
    if (!id || (status !== 'pending' && status !== 'running')) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      unsubscribe = subscribeToJobEvents(
        id,
        config.apiBaseUrl,
        (nextStage) => {
          setStage(nextStage);
          setStatus((current) => (current === 'pending' ? 'running' : current));
          if (nextStage === 'diff_ready' || nextStage === 'failed') {
            getJob(id).then((job) => {
              setStatus(job.status);
              setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
            });
          }
        },
        (narration) => {
          // Cap accumulated narrations -- a long-running SURVEY job with
          // many branches could otherwise grow this list unboundedly for
          // the duration of the whole job.
          setNarrations((current) => [...current, narration].slice(-50));
        },
      );
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, status]);

  async function handleConfirm(): Promise<void> {
    if (!id || !orgUrl || !pat || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      await confirmJob(id, { orgUrl, pat });
      const job = await getJob(id);
      setStatus(job.status);
    } catch {
      setMutationError('Confirm failed — the job may be safe to retry. Check the Audit tab for details.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  async function handleReject(): Promise<void> {
    if (!id || isMutatingRef.current) return;
    isMutatingRef.current = true;
    setIsMutating(true);
    setMutationError(null);
    try {
      await rejectJob(id);
      setStatus('rejected');
    } catch {
      setMutationError('Reject failed — please try again.');
    } finally {
      isMutatingRef.current = false;
      setIsMutating(false);
    }
  }

  // Downloads the server-computed summary (GET /jobs/:id/summary) as a JSON
  // file -- a real, exportable report distinct from the diff itself.
  async function handleDownloadSummary(): Promise<void> {
    if (!id) return;
    const summary = await getSummary(id);
    const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `job-${id}-summary.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleToggleExclude(localId: string, excluded: boolean): Promise<void> {
    if (!id) return;
    const result = await setDiffEntryExcluded(id, localId, excluded);
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }

  async function handleSaveEdit(localId: string, patch: { title: string; description: string }): Promise<void> {
    if (!id) return;
    const result = await editDiffEntry(id, localId, patch);
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }

  async function handleAddChild(parentLocalId: string, input: { type: string; title: string; description: string }): Promise<void> {
    if (!id) return;
    const result = await addDiffEntry(id, { parentLocalId, ...input });
    setDiff((result.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
  }

  async function handleShowAudit(): Promise<void> {
    if (!id) return;
    setTab('audit');
    setAudit(await getAudit(id));
  }

  const selectedEntry = diff.find((entry) => entry.localId === selectedId) ?? null;

  if (status === 'failed') {
    return (
      <Box p={4}>
        <Typography variant="h5" color="error">Job Failed</Typography>
        <Typography>This job did not complete successfully. Check the Audit tab for details.</Typography>
        <Button onClick={handleShowAudit}>View Audit</Button>
        {tab === 'audit' && audit.map((entry) => <Typography key={entry.id}>{entry.message}</Typography>)}
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" p={2}>
        {status && <StatusChip status={status} />}
        <Stack direction="row" spacing={1}>
          <Button size="small" onClick={handleDownloadSummary}>
            Download summary
          </Button>
          {status === 'diff_ready' && (
            <>
              <Button variant="outlined" color="error" onClick={handleReject} disabled={isMutating}>
                Reject
              </Button>
              <Button variant="contained" onClick={handleConfirm} disabled={isMutating}>
                Confirm
              </Button>
            </>
          )}
        </Stack>
      </Box>
      {mutationError && (
        <Alert severity="error" sx={{ mx: 2, mb: 2 }} onClose={() => setMutationError(null)}>
          {mutationError}
        </Alert>
      )}
      {warnings.length > 0 && (
        <Stack spacing={1} sx={{ px: 2, mb: 2 }}>
          {warnings.map((warning, index) => (
            <Alert key={index} severity="warning">
              {warning}
            </Alert>
          ))}
        </Stack>
      )}
      {status === 'running' && stage && mode && startedAt && (
        <ProgressBanner stage={stage} startedAt={startedAt} mode={mode as 'baseline' | 'survey'} narrations={narrations} />
      )}
      {summary && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, mb: 1 }}>
          {summary.created} new · {summary.reused} reused
          {summary.dedupSkipped > 0
            ? ` · ${summary.dedupSkipped} probable duplicate${summary.dedupSkipped === 1 ? '' : 's'} skipped`
            : ''}
        </Typography>
      )}
      <Tabs value={tab} onChange={(_event, value) => (value === 'audit' ? handleShowAudit() : setTab(value))}>
        <Tab value="tree" label="Diff" />
        <Tab value="audit" label="Audit" />
      </Tabs>
      {tab === 'tree' ? (
        <Grid container>
          <Grid item xs={7}>
            <DiffTree
              entries={diff}
              selectedId={selectedId}
              onSelect={setSelectedId}
              filterAction={null}
              filterText=""
              onToggleExclude={handleToggleExclude}
            />
          </Grid>
          <Grid item xs={5}>
            <NodeDetailPanel
              jobId={id!}
              entry={selectedEntry}
              jobMode={mode as 'baseline' | 'survey' | null}
              kbCitations={kbCitations}
              onSave={handleSaveEdit}
            />
            {selectedId && status === 'diff_ready' && selectedEntry && (
              <AddChildForm
                parentEntry={selectedEntry}
                jobMode={mode as 'baseline' | 'survey'}
                onAdd={(input) => handleAddChild(selectedId, input)}
              />
            )}
          </Grid>
        </Grid>
      ) : (
        <Box p={2}>
          {audit.map((entry) => (
            <Typography key={entry.id}>{entry.message}</Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}
