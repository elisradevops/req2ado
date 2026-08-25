import { httpClient } from './httpClient';

/**
 * App-wide settings (orchestrator's AppSettings singleton row) -- shared by
 * every user, not per-session preferences. UI-only preferences (dense view,
 * auto-sync) live in uiPreferencesStore/localStorage instead.
 */
export interface AppSettings {
  // Cosine similarity in [0, 1]. At or above this, dedup_check treats a
  // proposed item as an existing duplicate and skips it (dedup_skip).
  dedupThreshold: number;
}

export async function getAppSettings(): Promise<AppSettings> {
  const response = await httpClient.get<AppSettings>('/settings');
  return response.data;
}

export async function updateAppSettings(dedupThreshold: number): Promise<AppSettings> {
  const response = await httpClient.put<AppSettings>('/settings', { dedupThreshold });
  return response.data;
}
