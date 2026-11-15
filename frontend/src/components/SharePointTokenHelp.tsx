// The steps a first-time user needs to get a SharePoint access token for the knowledge base. Shared by the two places that reconnect SharePoint
// (the Knowledge base page and Settings), so the wording cannot drift. It names no permission and no lifetime: the app does not say which scope
// the folder needs, and the connection status shows when the pasted token expires.
export const SHAREPOINT_TOKEN_DIALOG_DESCRIPTION =
  'Paste a fresh access token. It is checked against SharePoint before saving. One token serves everyone who uses the knowledge base, so it carries the access of whoever pastes it.';

export function SharePointTokenHelp(): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 text-sm text-ink-2">
      <p className="font-medium text-ink-1">Where to get a token</p>
      <ol aria-label="Steps to get a token" className="flex list-decimal flex-col gap-1 pl-5">
        <li>
          Open{' '}
          <a
            href="https://developer.microsoft.com/graph/graph-explorer"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            Graph Explorer
          </a>{' '}
          and sign in with the account that can open the folder.
        </li>
        <li>Open the Access token tab and copy the whole token. It is long.</li>
        <li>Paste it below.</li>
      </ol>
    </div>
  );
}
