// A SharePoint or OneDrive sharing link for display. The link IS the credential for the folder it names: the token sits in the query string
// (`?e=...`) and, in a sharing link, as the last path segment. Showing it on a page that is read over shoulders and captured in screenshots
// helps nobody, so the display drops the query and hash and hides the token by where it is:
//  - a SharePoint sharing link starts with a marker segment (`/:f:/s/<site>/<token>`, `/:f:/g/personal/<user>/<token>`): its last segment is
//    the token, whatever it looks like (one with no digits is still a token), and the readable segments before it are kept. The "r" form
//    (`/:f:/r/sites/...`) names a folder by path and has no token, so it is left whole;
//  - any other link (the short `1drv.ms/f/s!<token>` form, say) falls back to a look at the segment itself: long, no spaces, a generated mix.
// The full link is still what the Change form edits and what the requests use; only the text on screen is shortened.
const MARKER = /^:[a-z]:$/i;
const TOKEN_SEGMENT = /^[A-Za-z0-9_!~.-]{16,}$/;

function looksLikeToken(segment: string): boolean {
  // Long, no spaces, and a mix that reads as generated: a digit and a letter, in mixed case or with a "!".
  return TOKEN_SEGMENT.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment) && ((/[a-z]/.test(segment) && /[A-Z]/.test(segment)) || segment.includes('!'));
}

export function redactSharingUrl(url: string): string {
  const withoutTail = url.split('#')[0].split('?')[0];
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter((segment) => segment !== '');
    const isSharingLink = parts.length > 1 && MARKER.test(parts[0]) && parts[1].toLowerCase() !== 'r';
    const shown = isSharingLink
      ? parts.map((segment, index) => (index === parts.length - 1 ? '…' : segment))
      : parts.map((segment) => (looksLikeToken(segment) ? '…' : segment));
    return `${parsed.origin}${shown.length > 0 ? `/${shown.join('/')}` : ''}`;
  } catch {
    return withoutTail;
  }
}
