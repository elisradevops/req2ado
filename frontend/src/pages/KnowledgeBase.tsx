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
import { isAxiosError } from 'axios';
import { ingestFolderUrl, ingestUrl, listIngestedDocuments, type IngestedDocument } from '../api/kb';
import { useToast } from '../components/ToastProvider';
import { useUserId } from '../store/authStore';

// Maps the backend's Graph/SharePoint error status codes (see
// ingestion/app/kb/graph_client.py's _error_for_status and
// app/main.py's kb_ingest_url/kb_ingest_folder_url) to an actionable message
// -- these are NOT interchangeable: a 401 means the configured
// SHAREPOINT_TOKEN expired (nothing wrong with the link), while a 404 means
// the link itself is wrong. Collapsing all of them into one generic
// "check the sharing link" message (the prior behavior) actively misleads
// on the token-expiry case, the single most common real-world failure.
function describeIngestError(error: unknown): string {
  if (isAxiosError(error)) {
    switch (error.response?.status) {
      case 400:
        return 'SharePoint access isn’t configured on the server (no access token set) — contact an admin.';
      case 401:
        return 'The server’s SharePoint access token has expired or is invalid — ask an admin to refresh it, then try again.';
      case 403:
        return 'The configured SharePoint access token doesn’t have permission to read this link.';
      case 404:
        return 'File or folder not found at this sharing link — double check the URL.';
      case 502:
        return 'Could not reach Microsoft Graph — check network connectivity and try again.';
      default:
        break;
    }
  }
  return 'Ingest failed — check the sharing link and try again.';
}

export function KnowledgeBase(): React.ReactElement {
  const { showToast } = useToast();
  const userId = useUserId();
  const [documents, setDocuments] = useState<IngestedDocument[]>([]);
  const [url, setUrl] = useState('');
  const [docType, setDocType] = useState('');
  const [isFolder, setIsFolder] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const isIngestingRef = useRef(false);

  useEffect(() => {
    if (!userId) return;
    listIngestedDocuments(userId)
      .then(setDocuments)
      .catch(() => showToast('Failed to load ingested documents.', 'error'));
  }, [showToast, userId]);

  async function refreshDocuments(): Promise<void> {
    if (!userId) return;
    try {
      setDocuments(await listIngestedDocuments(userId));
    } catch {
      showToast('Ingested, but the document list failed to refresh — reload the page.', 'error');
    }
  }

  async function handleIngest(): Promise<void> {
    if (isIngestingRef.current || !userId) return;
    isIngestingRef.current = true;
    setIngesting(true);
    try {
      if (isFolder) {
        const result = await ingestFolderUrl(url, userId, docType || undefined, recursive);
        const ingested = result.files.filter((f) => f.status === 'ingested').length;
        const skipped = result.files.filter((f) => f.status === 'skipped_unchanged').length;
        const failed = result.files.filter((f) => f.status === 'failed');
        if (result.files.length === 0) {
          showToast('Folder is empty — no files were found to ingest.', 'info');
        } else if (failed.length > 0) {
          showToast(
            `Folder ingest: ${ingested} ingested, ${skipped} skipped, ${failed.length} failed (${failed
              .map((f) => (f.reason ? `${f.file}: ${f.reason}` : f.file))
              .join('; ')}).`,
            'error',
          );
        } else {
          showToast(`Folder ingest: ${ingested} ingested, ${skipped} skipped.`, 'success');
        }
      } else {
        const result = await ingestUrl(url, userId, docType || undefined);
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
    } catch (error) {
      showToast(describeIngestError(error), 'error');
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
        a shared folder (single level, no subfolders). Documents you ingest are only ever visible to
        your own SURVEY jobs.
      </Typography>
      <Box display="flex" flexDirection="column" gap={2} maxWidth={480} my={2}>
        <TextField label="Sharing URL" value={url} onChange={(event) => setUrl(event.target.value)} />
        <FormControlLabel
          control={<Checkbox checked={isFolder} onChange={(event) => setIsFolder(event.target.checked)} />}
          label="This is a folder"
        />
        {isFolder && (
          <FormControlLabel
            control={<Checkbox checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />}
            label="Include subfolders"
          />
        )}
        <TextField label="Doc Type (optional)" value={docType} onChange={(event) => setDocType(event.target.value)} />
        <Button
          variant="contained"
          onClick={handleIngest}
          disabled={!url || !userId || ingesting}
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
