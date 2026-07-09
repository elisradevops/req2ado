export interface RuntimeConfig {
  apiBaseUrl: string;
}

let cached: RuntimeConfig | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  const response = await fetch('/config.json');
  cached = (await response.json()) as RuntimeConfig;
  return cached;
}
