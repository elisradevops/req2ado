// The last SharePoint folder a person browsed in the Knowledge Base, so coming back does not mean pasting the link again. A per-viewer
// convenience in localStorage, under the signed-in user's own key: it used to be one global key, so the next person to sign in on the same
// browser was shown (and auto-browsed) the previous person's folder. Every access is guarded: storage can be blocked or throw.
export const LEGACY_KB_BROWSE_URL_KEY = 'req2ado-kb-browse-url';

export function kbBrowseUrlKey(userId: string): string {
  return `${LEGACY_KB_BROWSE_URL_KEY}:${userId}`;
}

// The old global key is never read: it belonged to whoever browsed last.
export function readKbBrowseUrl(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(kbBrowseUrlKey(userId)) || null;
  } catch {
    return null;
  }
}

export function writeKbBrowseUrl(userId: string | null, url: string): void {
  if (!userId) return;
  try {
    localStorage.setItem(kbBrowseUrlKey(userId), url);
  } catch {
    // Best effort.
  }
}

// A link an earlier version left under the old global key is a credential nobody reads any more: removed as soon as the page opens, not
// only at the next sign-out.
export function removeLegacyKbBrowseUrl(): void {
  try {
    localStorage.removeItem(LEGACY_KB_BROWSE_URL_KEY);
  } catch {
    // Best effort.
  }
}

// On sign-out: the user's own key and the old global one. Another user's key is theirs.
export function clearKbBrowseUrl(userId: string | null): void {
  try {
    if (userId) localStorage.removeItem(kbBrowseUrlKey(userId));
    localStorage.removeItem(LEGACY_KB_BROWSE_URL_KEY);
  } catch {
    // Best effort.
  }
}
