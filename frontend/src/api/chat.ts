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
