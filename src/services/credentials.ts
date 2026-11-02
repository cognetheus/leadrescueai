import type { Repositories } from '../db/repositories';
import { PipelineError } from '../domain/failure';

/** Read access to provider credentials for the pipeline (refresh lives in the remediation layer). */
export class CredentialService {
  constructor(private repos: Repositories) {}

  crmAccessToken(tenantId: string): string {
    const cred = this.repos.credentials.get(tenantId, 'crm');
    if (!cred) throw new PipelineError({ failureClass: 'permanent', code: 'crm_not_connected', stage: 'credentials', message: 'Tenant has no CRM connection' });
    if (cred.status === 'revoked') {
      throw new PipelineError({ failureClass: 'permanent', code: 'crm_credentials_revoked', stage: 'credentials', message: 'CRM connection was revoked and must be re-authorized' });
    }
    return cred.secrets.accessToken;
  }

  metaPageToken(tenantId: string): string {
    const cred = this.repos.credentials.get(tenantId, 'meta');
    if (!cred || cred.status === 'revoked') {
      throw new PipelineError({ failureClass: 'permanent', code: 'source_not_connected', stage: 'credentials', message: 'Tenant has no active lead source connection' });
    }
    return cred.secrets.pageAccessToken;
  }
}
