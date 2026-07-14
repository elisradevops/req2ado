import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import { ingestFolderUrl, ingestUrl, listIngestedDocuments, type IngestedDocument } from '../api/kb';
import { useToast } from '../components/ToastProvider';

export function KnowledgeBase(): React.ReactElement {
  const { showToast } = useToast();
  const [documents, setDocuments] = useState<IngestedDocument[]>([]);
  const [url, setUrl] = useState('');
  const [areaPath, setAreaPath] = useState('');
  const [docType, setDocType] = useState('');
  const [isFolder, setIsFolder] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const isIngestingRef = useRef(false);

  useEffect(() => {
    listIngestedDocuments()
      .then(setDocuments)
      .catch(() => showToast('Failed to load ingested documents.', 'error'));
  }, [showToast]);

  async function refreshDocuments(): Promise<void> {
    try {
      setDocuments(await listIngestedDocuments());
    } catch {
      showToast('Ingested, but the document list failed to refresh — reload the page.', 'error');
    }
  }

  async function handleIngest(): Promise<void> {
    if (isIngestingRef.current) return;
    isIngestingRef.current = true;
    setIngesting(true);
    try {
      if (isFolder) {
        const result = await ingestFolderUrl(url, areaPath, docType || undefined);
        const ingested = result.files.filter((f) => f.status === 'ingested').length;
        const skipped = result.files.filter((f) => f.status === 'skipped_unchanged').length;
        const failed = result.files.filter((f) => f.status === 'failed');
        if (result.files.length === 0) {
          showToast('Folder is empty — no files were found to ingest.', 'info');
        } else if (failed.length > 0) {
          showToast(
            `Folder ingest: ${ingested} ingested, ${skipped} skipped, ${failed.length} failed (${failed.map((f) => f.file).join(', ')}).`,
            'error',
          );
        } else {
          showToast(`Folder ingest: ${ingested} ingested, ${skipped} skipped.`, 'success');
        }
      } else {
        const result = await ingestUrl(url, areaPath, docType || undefined);
        showToast(
          result.skippedUnchanged
            ? 'Already up to date — no changes.'
            : `Ingested "${result.documentName}" — ${result.chunksStored} chunk(s) stored.`,
          'success',
        );
      }
      setUrl('');
      setDocType('');
      await refreshDocuments();
    } catch {
      showToast(
        isFolder ? 'Folder ingest failed — check the sharing link and try again.' : 'Ingest failed — check the sharing link and try again.',
        'error',
      );
    } finally {
      isIngestingRef.current = false;
      setIngesting(false);
    }
  }

  return (
    <Box>
      <Typography variant="h5">Knowledge Base</Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        The SharePoint access token is configured server-side; paste a SharePoint/OneDrive sharing
        link to ingest a document, or check "This is a folder" to ingest every file directly inside
        a shared folder (single level, no subfolders).
      </Typography>
      <Box display="flex" flexDirection="column" gap={2} maxWidth={480} my={2}>
        <TextField label="Sharing URL" value={url} onChange={(event) => setUrl(event.target.value)} />
        <FormControlLabel
          control={<Checkbox checked={isFolder} onChange={(event) => setIsFolder(event.target.checked)} />}
          label="This is a folder"
        />
        <TextField label="Area Path" value={areaPath} onChange={(event) => setAreaPath(event.target.value)} />
        <TextField label="Doc Type (optional)" value={docType} onChange={(event) => setDocType(event.target.value)} />
        <Button
          variant="contained"
          onClick={handleIngest}
          disabled={!url || !areaPath || ingesting}
        >
          {ingesting ? 'Ingesting…' : isFolder ? 'Ingest Folder' : 'Ingest'}
        </Button>
      </Box>
      <List>
        {documents.map((document) => (
          <ListItem key={document.id}>
            <ListItemText
              primary={document.name}
              secondary={`${document.docType ?? '—'} — ${Math.round(document.sizeBytes / 1024)} KB — ${document.ingestedAt}`}
            />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
