// Shared between the guard (reads it) and the auth controller (sets/clears
// it) -- must stay a single source of truth so a name typo in one place
// can't silently desync from the other.
export const SESSION_COOKIE_NAME = 'req2ado_session';

// 7 days -- long enough that a reviewer mid-SURVEY-job (15-40+ min runs,
// plus review time) never gets logged out mid-task, short enough that a
// stolen cookie doesn't grant indefinite access.
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
