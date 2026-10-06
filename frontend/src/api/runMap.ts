import axios from 'axios';
import { httpClient } from './httpClient';
import type { DocumentMap } from './liveTypes';

/**
 * The document map of a running job (counts and outline), owner-scoped. Returns
 * null when the server has none: the feature is off, the run has not parsed the
 * document yet, or the job is not this user's. All of those mean "do not show
 * the outline", never an error.
 */
export async function getRunMap(jobId: string): Promise<DocumentMap | null> {
  try {
    const response = await httpClient.get<DocumentMap>(`/jobs/${jobId}/run-map`);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
}

/**
 * The refs of items the run has already finished. The event stream replays only
 * the latest frame per lane, so a page opened mid-run reads this once to fill in
 * the outline. Null when the feature is off or the job is not this user's.
 */
export async function getRunDone(jobId: string): Promise<string[] | null> {
  try {
    const response = await httpClient.get<{ refs: string[] }>(`/jobs/${jobId}/run-done`);
    return Array.isArray(response.data?.refs) ? response.data.refs : null;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
}
