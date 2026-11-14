import { httpClient } from './httpClient';

export interface LlmConnectionStatus {
  configured: boolean;
  chatModel?: string;
  visionModel?: string;
}

export interface LlmSelectableModel {
  id: string;
  name: string;
  vision: boolean;
}

export async function getLlmConnection(): Promise<LlmConnectionStatus> {
  const response = await httpClient.get<LlmConnectionStatus>('/llm/connection');
  return response.data;
}

// `token` previews a candidate token that isn't saved yet -- the Settings dialog calls this as soon as the user pastes a token, before Save, to
// populate the chat/vision model dropdowns. It goes in a POST body: an API key in a query string is written to every access log. Omitted, it
// lists models for the caller's already-stored connection instead.
export async function getLlmConnectionModels(token?: string): Promise<LlmSelectableModel[]> {
  const response = token
    ? await httpClient.post<{ models: LlmSelectableModel[] }>('/llm/connection/models/preview', { token })
    : await httpClient.get<{ models: LlmSelectableModel[] }>('/llm/connection/models');
  return response.data.models;
}

// `embeddings: 'unavailable'` means the connection was saved but this account cannot get an embedding, so duplicate detection cannot use it.
export async function setLlmConnection(apiKey: string, chatModel: string, visionModel?: string): Promise<{ embeddings?: 'unavailable' }> {
  const response = await httpClient.post<{ ok: true; embeddings?: 'unavailable' }>('/llm/connection', { apiKey, chatModel, ...(visionModel ? { visionModel } : {}) });
  return { ...(response?.data?.embeddings ? { embeddings: response.data.embeddings } : {}) };
}
