// Why a SharePoint reconnect did not go through, in words that tell the user what to do next. Only a token SharePoint refused is a reason to
// fetch a new one: when the check itself could not run (SharePoint down, or this app's server not answering) nothing was saved and the
// saved token is unchanged, so "rejected that token" would send the user to Graph Explorer for nothing.
export type ReconnectOutcome = 'invalid' | 'unreachable' | 'not_configured' | 'error';

const REJECTED = 'SharePoint rejected that token. Check you copied the whole value — they are long.';

export function reconnectFailureMessage(outcome: ReconnectOutcome): string {
  if (outcome === 'unreachable') return "Couldn't reach SharePoint to check this token, so nothing was saved. The saved token is unchanged. Try again in a moment.";
  if (outcome === 'error') return "Couldn't check the token just now (the app's server did not answer), so nothing was saved. Try again in a moment.";
  return REJECTED;
}
