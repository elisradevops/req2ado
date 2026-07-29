import { httpClient } from './httpClient';

/**
 * Revokes the real server session (auth.controller.ts's session.service.ts
 * -- a DELETE against the Session table, not a JWT that stays valid until
 * expiry regardless). Must be called before/alongside clearing local auth
 * state (authStore.logout()) -- clearing local state alone leaves the
 * httpOnly cookie's session alive server-side until its 7-day TTL.
 */
export async function logoutSession(): Promise<void> {
  await httpClient.post('/auth/logout');
}
