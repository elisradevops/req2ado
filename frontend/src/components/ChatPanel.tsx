import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import { getChatHistory, listModels, sendChatTurn, stopChatTurn, type ChatMessage } from '../api/chat';
import { useChatSocket, type StreamEvent } from '../hooks/useChatSocket';
import { useToast } from './ToastProvider';
import { themeTokens } from '../theme/tokens';

interface Proposal {
  proposedTitle: string | null;
  proposedDescription: string | null;
}

const HISTORY_DISPLAY_LIMIT = 50;

export function ChatPanel({
  jobId,
  localId,
  disabled,
  onAcceptProposal,
}: {
  jobId: string;
  localId: string;
  disabled: boolean;
  onAcceptProposal: (patch: { title?: string; description?: string }) => void;
}): React.ReactElement {
  const { showToast } = useToast();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [streaming, setStreaming] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  // Reset chat state whenever the selected node changes so a stale
  // proposal/history from a different node can never be shown or accepted
  // onto the newly-selected one.
  useEffect(() => {
    setHistory([]);
    setProposal(null);
    setDraft('');
    setModel(undefined);
    setStreaming('');
    setIsStreaming(false);
  }, [jobId, localId]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    getChatHistory(jobId, localId).then((h) => {
      if (!cancelled) setHistory(h);
    });
    listModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, localId, disabled]);

  useChatSocket(
    jobId,
    localId,
    (event: StreamEvent) => {
      if (disabled) return;
      if (event.type === 'chunk') {
        setStreaming((prev) => prev + (event.delta ?? ''));
      } else if (event.type === 'done') {
        setIsStreaming(false);
        setStreaming('');
        setHistory((prev) => [
          ...prev,
          {
            id: `local-${prev.length}`,
            role: 'assistant',
            content: event.message ?? '',
            proposedTitle: event.proposedTitle ?? null,
            proposedDescription: event.proposedDescription ?? null,
            model: event.model ?? null,
            createdAt: new Date().toISOString(),
          },
        ]);
        if (event.proposedTitle || event.proposedDescription) {
          setProposal({ proposedTitle: event.proposedTitle ?? null, proposedDescription: event.proposedDescription ?? null });
        }
      } else if (event.type === 'error') {
        setIsStreaming(false);
        setStreaming('');
        showToast(`Chat reply failed: ${event.reason ?? 'unknown error'}`, 'error');
      }
    },
    !disabled,
  );

  async function send(): Promise<void> {
    if (!draft.trim() || isStreaming) return;
    const text = draft;
    setDraft('');
    setHistory((prev) => [
      ...prev,
      {
        id: `local-user-${prev.length}`,
        role: 'user',
        content: text,
        proposedTitle: null,
        proposedDescription: null,
        model: model ?? null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setIsStreaming(true);
    setProposal(null);
    try {
      await sendChatTurn(jobId, localId, text, model);
    } catch {
      setIsStreaming(false);
      showToast('Failed to send chat message.', 'error');
    }
  }

  async function stop(): Promise<void> {
    await stopChatTurn(jobId, localId);
  }

  function acceptProposal(): void {
    if (!proposal) return;
    onAcceptProposal({
      title: proposal.proposedTitle ?? undefined,
      description: proposal.proposedDescription ?? undefined,
    });
    setProposal(null);
  }

  if (disabled) {
    return (
      <Box p={2}>
        <Typography color="text.secondary">Chat is unavailable for this item.</Typography>
      </Box>
    );
  }

  const visibleHistory = history.slice(-HISTORY_DISPLAY_LIMIT);

  return (
    <Box p={2} sx={{ borderTop: `1px solid ${themeTokens.color.border}` }}>
      <Typography variant="overline">Chat</Typography>
      <Box sx={{ maxHeight: 240, overflowY: 'auto', mb: 1 }}>
        {visibleHistory.map((m) => (
          <Box key={m.id} sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {m.role === 'user' ? 'You' : m.model ? `Assistant (${m.model})` : 'Assistant'}
            </Typography>
            <Typography variant="body2">{m.content}</Typography>
          </Box>
        ))}
        {isStreaming && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{ color: themeTokens.color.liveAccent }}>
              Assistant (typing…)
            </Typography>
            <Typography variant="body2">{streaming}</Typography>
          </Box>
        )}
      </Box>
      {proposal && (
        <Box sx={{ border: `1px solid ${themeTokens.color.border}`, borderRadius: `${themeTokens.radius.sm}px`, p: 1, mb: 1 }}>
          <Typography variant="caption">Proposed change</Typography>
          {proposal.proposedTitle && (
            <Typography variant="body2">
              <strong>Title:</strong> {proposal.proposedTitle}
            </Typography>
          )}
          {proposal.proposedDescription && (
            <Typography variant="body2">
              <strong>Description:</strong> {proposal.proposedDescription}
            </Typography>
          )}
          <Button size="small" variant="contained" onClick={acceptProposal}>
            Accept
          </Button>
          <Button size="small" onClick={() => setProposal(null)}>
            Reject
          </Button>
        </Box>
      )}
      <TextField
        select
        label="Model"
        value={model ?? ''}
        onChange={(e) => setModel(e.target.value || undefined)}
        size="small"
        sx={{ minWidth: 160, mr: 1 }}
        SelectProps={{ MenuProps: { keepMounted: true } }}
      >
        <MenuItem value="">Default</MenuItem>
        {models.map((m) => (
          <MenuItem key={m} value={m}>
            {m}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        size="small"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Ask the assistant to refine this item…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Button variant="contained" onClick={send} disabled={isStreaming}>
        Send
      </Button>
      {isStreaming && <Button onClick={stop}>Stop generating</Button>}
    </Box>
  );
}
