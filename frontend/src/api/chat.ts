import { httpClient } from './httpClient';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposedTitle: string | null;
  proposedDescription: string | null;
  model: string | null;
  createdAt: string;
}

export async function listModels(): Promise<string[]> {
  const response = await httpClient.get<{ models: string[] }>('/chat/models');
  return response.data.models;
}

export async function getChatHistory(jobId: string, localId: string): Promise<ChatMessage[]> {
  const response = await httpClient.get<{ messages: ChatMessage[] }>(`/jobs/${jobId}/diff/${localId}/chat`);
  return response.data.messages;
}

export async function sendChatTurn(jobId: string, localId: string, message: string, model?: string): Promise<void> {
  await httpClient.post(`/jobs/${jobId}/diff/${localId}/chat`, { message, model });
}

export async function stopChatTurn(jobId: string, localId: string): Promise<void> {
  await httpClient.post(`/jobs/${jobId}/diff/${localId}/chat/stop`);
}

export interface RewriteWarning {
  code: string;
  // `high`: content was probably lost or the item became several items; `notice`: something changed that was not necessarily asked for.
  severity: 'high' | 'notice';
  detail: string;
}

/** A proposed rewrite judged against the current item: both texts scored together, plus what can be seen in the two texts. */
export interface RewriteComparison {
  before: { score: number | null };
  after: { score: number | null };
  // after - before; null when the model could not score both texts (the warnings still stand).
  delta: number | null;
  warnings: RewriteWarning[];
}

// Read-only: nothing in the job changes. Throws on failure; the caller treats that as "not checked", never as "fine".
export async function checkRewrite(
  jobId: string,
  localId: string,
  // warningsOnly: only the checks that need no model, answered at once (the scored prediction can take as long as a model call).
  proposal: { proposedTitle: string | null; proposedDescription: string; warningsOnly?: boolean },
): Promise<RewriteComparison> {
  const response = await httpClient.post<RewriteComparison>(`/jobs/${jobId}/diff/${localId}/rewrite-check`, proposal);
  return response.data;
}
