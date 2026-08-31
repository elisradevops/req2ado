import { httpClient } from './httpClient';

export interface LlmStatus {
  status: 'reachable' | 'unreachable' | 'not_configured';
  latencyMs: number | null;
}

export async function getLlmStatus(): Promise<LlmStatus> {
  const response = await httpClient.get<LlmStatus>('/llm/status');
  return response.data;
}
