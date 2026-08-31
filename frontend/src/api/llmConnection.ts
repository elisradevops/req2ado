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

// `token` previews a candidate token that isn't saved yet -- the Settings
// dialog calls this as soon as the user pastes a token, before Save, to
// populate the chat/vision model dropdowns. Omitted, it lists models for
// the caller's already-stored connection instead.
export async function getLlmConnectionModels(token?: string): Promise<LlmSelectableModel[]> {
  const response = await httpClient.get<{ models: LlmSelectableModel[] }>('/llm/connection/models', {
    params: token ? { token } : {},
  });
  return response.data.models;
}

export async function setLlmConnection(apiKey: string, chatModel: string, visionModel?: string): Promise<void> {
  await httpClient.post('/llm/connection', { apiKey, chatModel, ...(visionModel ? { visionModel } : {}) });
}
