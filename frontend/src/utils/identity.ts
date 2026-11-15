// Small, display-only helpers for showing who is signed in.

/** One or two letters for an avatar: the first letters of the first and last word of the name. Works for any script. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0];
  if (words.length === 1) return first.toLocaleUpperCase();
  return (first + Array.from(words[words.length - 1])[0]).toLocaleUpperCase();
}

/**
 * A short, stable handle for an identifier, to say "this is you" in support conversations without printing the whole id. A display
 * value only (FNV-1a), not a security measure: the full id is still one click away for whoever needs it.
 */
export function shortHandle(id: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The server and collection of an Azure DevOps address; null when it is not an address. */
export function serverOf(orgUrl: string | null | undefined): { host: string; collection: string | null } | null {
  if (!orgUrl) return null;
  try {
    const url = new URL(orgUrl);
    const collection = url.pathname.replace(/^\/+|\/+$/g, '');
    return { host: url.host, collection: collection || null };
  } catch {
    return null;
  }
}
