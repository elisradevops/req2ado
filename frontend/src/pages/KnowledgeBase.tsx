import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import { createKbSource, listKbSources, syncKbSource, type KbSourceSummary } from '../api/kb';
import { useToast } from '../components/ToastProvider';

export function KnowledgeBase(): React.ReactElement {
  const { showToast } = useToast();
  const [sources, setSources] = useState<KbSourceSummary[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [library, setLibrary] = useState('');
  const [folder, setFolder] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listKbSources()
      .then(setSources)
      .catch(() => showToast('Failed to load knowledge base sources.', 'error'));
  }, [showToast]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    try {
      const created = await createKbSource({ displayName, siteUrl, library, folder, areaPath });
      setSources((prev) => [created, ...prev]);
      setDisplayName('');
      setSiteUrl('');
      setLibrary('');
      setFolder('');
      setAreaPath('');
    } catch {
      showToast('Failed to add source — check the fields and try again.', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleSync(id: string): Promise<void> {
    if (!bearerToken) {
      showToast('Bearer token is required to sync.', 'error');
      return;
    }
    setSyncingId(id);
    try {
      const result = await syncKbSource(id, bearerToken);
      if (result.filesFailed.length > 0) {
        showToast(`Synced with ${result.filesFailed.length} file(s) failed — ${result.filesProcessed} file(s) processed, ${result.filesSkipped} skipped, ${result.chunksStored} chunk(s) stored.`, 'error');
      } else {
        showToast(`${result.filesProcessed} file(s) processed, ${result.filesSkipped} skipped, ${result.chunksStored} chunk(s) stored.`, 'success');
      }
    } catch {
      showToast('Sync failed — check the site URL, library, folder, and bearer token.', 'error');
    } finally {
      setSyncingId(null);
    }
    try {
      setSources(await listKbSources());
    } catch {
      showToast('Synced, but the source list failed to refresh — reload the page.', 'error');
    }
  }

  return (
    <Box>
      <Typography variant="h5">Knowledge Base</Typography>
      <Box display="flex" flexDirection="column" gap={2} maxWidth={480} my={2}>
        <TextField label="Display Name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        <TextField label="Site URL" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} />
        <TextField label="Library" value={library} onChange={(event) => setLibrary(event.target.value)} />
        <TextField label="Folder" value={folder} onChange={(event) => setFolder(event.target.value)} />
        <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} />
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={!displayName || !siteUrl || !library || !folder || !areaPath || creating}
        >
          Add Source
        </Button>
      </Box>
      <TextField
        label="Bearer Token (used for Sync, not stored)"
        type="password"
        value={bearerToken}
        onChange={(event) => setBearerToken(event.target.value)}
        fullWidth
        sx={{ maxWidth: 480, mb: 2 }}
      />
      <List>
        {sources.map((source) => (
          <ListItem
            key={source.id}
            secondaryAction={
              <Button onClick={() => handleSync(source.id)} disabled={syncingId === source.id}>
                {syncingId === source.id ? 'Syncing…' : 'Sync'}
              </Button>
            }
          >
            <ListItemText
              primary={source.displayName}
              secondary={`${source.areaPath} — last synced: ${source.lastSyncedAt ?? 'never'}`}
            />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
