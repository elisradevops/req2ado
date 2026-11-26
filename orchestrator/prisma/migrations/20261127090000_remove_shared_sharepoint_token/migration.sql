-- Data only: the one SharePoint token every user's knowledge base was read with (owner finding, 2026-11-26). Each user now connects their
-- own (stored under "user:<id>"); the shared row is deleted so no request can act with someone else's Microsoft identity. Batches paused
-- for a token wait for their own owner to connect.
DELETE FROM "ExternalCredential" WHERE "ownerKey" = 'shared' AND "kind" = 'sharepoint_token';
