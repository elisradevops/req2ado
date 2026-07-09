# DocGen's ADO + SharePoint connection pattern (reference for req2ado)

**Purpose of this doc:** DocGen is the user's own company app (`elisradevops/docgen-*`). This is
an internal-reuse reference, not third-party IP (see "Design integrity" in `req2ado-roadmap.md`).
req2ado's Phase 1 (ADO connectivity) and Phase 2 P2a (SharePoint connector) mirror this pattern.
All refs confirmed by investigation of the DocGen source this session.

## The core pattern: stateless, per-request credential passing

DocGen's gateway (`docgen-api-gate`, NestJS) is a pure forwarder. **Nothing sensitive is persisted
server-side.** Credentials are acquired client-side, sent fresh on every request, validated with a
lightweight round-trip before use, and never cached in a server session.

## ADO connection

- **Dual mode, auto-detected** — not user-chosen:
  - **Standalone**: user pastes org URL + PAT into a settings page. Detected when no ADO host
    signals are present. Credential persisted **client-side only** (cookies).
    `docgen-frontend/src/App.jsx:242-243` (renders `SettingsPage` when no signals + no cookies),
    `:35-84` (`login()` validates then stores).
  - **ADO-extension mode**: detected via URL params / iframe signals
    (`docgen-frontend/src/adoSdk.js:18-45`, `hasAdoHostSignals()`). Loads the VSS SDK via
    requirejs, calls `SDK.init`/`SDK.ready`, derives org/project context, and obtains the token via
    **`SDK.getAccessToken()`** (`adoSdk.js:57-92, 108-222`).
- **Wiring**: `App.jsx:107-155` — on extension mode, the token is prefixed `bearer:<token>` before
  being stored (`:123-128`), then `store.setCredentials(orgUrl, bearerToken)`.
- **Per-request header injection**: `docgen-frontend/src/store/actions/AzureDevopsRestApi.jsx:19-26`
  — every axios call to the gateway sets `X-Ado-Org-Url` and `X-Ado-PAT` headers. The client is
  constructed once with `(orgUrl, token)`.
- **Gateway reads fresh per request, forwards, stores nothing**:
  `docgen-api-gate/src/controllers/DataProviderController.ts:25-33` (`getCreds()` reads the two
  headers, 400s if missing) → `:35-55` (`forward()`) POSTs `{orgUrl, token, ...}` in the JSON body
  to the downstream content-control service on every call. No session/state held anywhere in the
  gateway.
- **Edge token-normalization — the key trick**: `docgen-data-provider-package/src/helpers/tfs.ts:49-73`,
  `applyAuth()`:
  - Token starting with `bearer:`/`bearer ` or JWT-shaped ⇒ `Authorization: Bearer <token>`
    (`:65-68`).
  - Otherwise (a PAT) ⇒ HTTP Basic auth `{username:'', password:<pat>}` (`:70-72`).
  - This single field cleanly carries either a standalone PAT or an extension-mode access token —
    the same downstream code path handles both, so adding extension mode later doesn't require
    touching the auth-application logic, only the token-acquisition side.
- **Validation before use**: `testCredentials(url, pat)` builds a temp client and calls
  `getUserDetails()`; only on success is the credential persisted
  (`docgen-frontend/src/store/DataStore.jsx:1447-1463`). On 401, the frontend clears cookies and
  fires an unauthorized event (`App.jsx:87-105`).

**req2ado mapping (Phase 1):** standalone mode only for now (matches req2ado's current
`POST /auth/login` shape), but adopt the same per-request header pattern (`X-Ado-Org-Url` /
`X-Ado-Pat`, already used on confirm — extend to the new area-path-read route too) and the same
edge normalization logic, so a future extension mode is a token-acquisition change only, not a
redesign of the auth-application path.

## SharePoint connection

- Supports **both** on-prem (NTLM) and SharePoint Online (OAuth bearer) — auth type detected by
  whether the site URL contains `.sharepoint.com`
  (`docgen-api-gate/src/services/SharePointService.ts:39-41`).
- **Credential travels per-request in the JSON body**, not headers:
  `{ siteUrl, library, folder, oauthToken | credentials }` — controller picks
  `auth = oauthToken || credentials` per call
  (`docgen-api-gate/src/controllers/SharePointController.ts:29-38, 54-63, 79-88, 187-207`).
- **Bearer (Online) path**: `makeOAuthRequest()` sets `Authorization: Bearer <token>` +
  `Accept: application/json;odata=verbose` (`SharePointService.ts:239-268`). Token is minted
  **entirely client-side** via an MSAL-style PKCE popup flow
  (`docgen-frontend/src/utils/sharepointOAuth.js:15-158`).
- **NTLM (on-prem) path**: `makeNTLMRequest()` uses the `httpntlm` package with
  `username`/`password`/`domain` (`SharePointService.ts:273-318`). Credentials gathered via a
  dialog (`SharePointCredentialsDialog.jsx:20-124`), cached only in `sessionStorage`
  (base64-encoded, session-scoped) — UI explicitly states "not stored on the server" (`:254`).
- **REST endpoints used** (folder/file enumeration only, no search API):
  `GetFolderByServerRelativeUrl('...')/Files`, `.../Folders`,
  `GetFileByServerRelativeUrl('...')/$value` for download.
- **What persists server-side is non-secret config only**: a Mongo model stores
  `siteUrl`/`library`/`folder`/`displayName`/`userId`/`projectName` — **never** a password or
  token (`docgen-api-gate/src/models/SharePointConfig.ts`, controller `:362-506`).

**req2ado mapping (Phase 2, P2a):** the user confirmed their SharePoint access is a **literal
bearer token**, sent the same way the ADO PAT is — so req2ado's connector uses DocGen's OAuth/
bearer path shape (`Authorization: Bearer <token>`, credential in the request body, secrets
client-side only, non-secret config persisted server-side), and can add the NTLM path later if a
future on-prem-without-token deployment needs it. No `@azure/msal-node` / ACS / Azure-AD
dependency needed for the bearer-token case.

## Summary — the one pattern to replicate

1. Credential acquired client-side (paste PAT / OAuth popup / VSS SDK token).
2. Sent fresh on **every** request (ADO: headers; SharePoint: body) — never a server session.
3. Gateway/orchestrator reads it per-request and forwards — holds nothing in memory or DB.
4. Token type normalized at the edge (bearer vs Basic/PAT) so one code path serves multiple auth
   sources.
5. Only non-secret config persists server-side; secrets live in the browser only
   (cookies/sessionStorage), for the session's duration.
