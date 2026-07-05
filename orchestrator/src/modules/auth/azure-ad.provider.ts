import { Injectable } from '@nestjs/common';

export interface AzureAdUser {
  email: string;
}

/**
 * Wraps the Azure AD auth-code exchange behind a stable interface so the
 * rest of the app never talks to MSAL directly. Until real tenant
 * credentials are configured (`AZURE_AD_*` env vars), `exchangeCode`
 * returns a deterministic stub user — swap the method body for a real
 * `@azure/msal-node` call without touching any caller.
 */
@Injectable()
export class AzureAdProvider {
  async exchangeCode(code: string): Promise<AzureAdUser> {
    if (!code) {
      throw new Error('Missing authorization code');
    }
    // TODO(Phase 0 follow-up, real tenant): replace with ConfidentialClientApplication.acquireTokenByCode
    return { email: 'dev-user@example.com' };
  }
}
