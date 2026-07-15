import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import { getJob, confirmJob, getAudit, editDiffEntry, setDiffEntryExcluded, addDiffEntry, type AuditEntry } from '../api/jobs';
import { subscribeToJobEvents, type JobStage } from '../api/events';
import { loadRuntimeConfig } from '../api/config';
import { useOrgUrl, usePat } from '../store/authStore';
import { StatusChip } from '../components/StatusChip';
import { ProgressBanner } from '../components/ProgressBanner';
import { DiffTree, type DryRunDiffEntry } from '../components/DiffTree';
import { NodeDetailPanel } from '../components/NodeDetailPanel';
import { AddChildForm } from '../components/AddChildForm';

export function JobDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const orgUrl = useOrgUrl();
  const pat = usePat();
  const [status, setStatus] = useState<string | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [diff, setDiff] = useState<DryRunDiffEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<JobStage | null>(null);
  const [tab, setTab] = useState<'tree' | 'audit'>('tree');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [startedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getJob(id).then((job) => {
      if (cancelled) return;
      setStatus(job.status);
      setMode(job.mode);
      setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || (status !== 'pending' && status !== 'running')) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      unsubscribe = subscribeToJobEvents(id, config.apiBaseUrl, (nextStage) => {
        setStage(nextStage);
        setStatus((current) => (current === 'pending' ? 'running' : current));
        if (nextStage === 'diff_ready' || nextStage === 'failed') {
          getJob(id).then((job) => {
            setStatus(job.status);
            setDiff((job.dryRunDiff as DryRunDiffEntry[] | null) ?? []);
          });
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, status]);

  async function handleConfirm(): Promise<void> {
    if (!id || !orgUrl || !pat) return;
    await confirmJob(id, { orgUrl, pat });
    const job = await getJob(id);
    setStatus(job.status);
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
        {status === 'diff_ready' && (
          <Button variant="contained" onClick={handleConfirm}>
            Confirm
          </Button>
        )}
      </Box>
      {status === 'running' && stage && mode && (
        <ProgressBanner stage={stage} startedAt={startedAt} mode={mode as 'baseline' | 'survey'} />
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
            <NodeDetailPanel entry={selectedEntry} onSave={handleSaveEdit} />
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
