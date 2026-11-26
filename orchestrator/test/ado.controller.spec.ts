import { AdoController } from '../src/modules/pipeline/ado.controller';
import type { SessionUser } from '../src/modules/auth/session.service';

const TEST_USER: SessionUser = { userId: 'user-descriptor-1', displayName: 'Jane Doe' };
const TEST_CREDENTIAL = { orgUrl: 'https://ado.example', pat: 'pat-123' };

function fakeResolver(credential: unknown = TEST_CREDENTIAL, hasCredential = true) {
  return { resolve: jest.fn().mockResolvedValue(hasCredential ? credential : undefined) };
}

describe('AdoController.getAreaPaths', () => {
  it('resolves the credential from the vault by session userId and forwards it to mcpClient', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const resolver = fakeResolver();
    const controller = new AdoController(mcpClient as any, resolver as any);

    const result = await controller.getAreaPaths(TEST_USER, 3, undefined);

    expect(resolver.resolve).toHaveBeenCalledWith(TEST_USER.userId);
    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(3, undefined, TEST_CREDENTIAL);
    expect(result).toEqual({ path: 'Project', children: [] });
  });

  it('uses default depth of 5 when not provided', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    const result = await controller.getAreaPaths(TEST_USER, 5, undefined);

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(5, undefined, TEST_CREDENTIAL);
    expect(result).toEqual({ path: 'Project', children: [] });
  });

  it('forwards a project query param when provided', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'OtherProject', children: [] }) };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    await controller.getAreaPaths(TEST_USER, 5, 'OtherProject');

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(5, 'OtherProject', TEST_CREDENTIAL);
  });

  it('passes undefined to mcpClient when the caller has no vaulted credential', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const controller = new AdoController(mcpClient as any, fakeResolver(undefined, false) as any);

    await controller.getAreaPaths(TEST_USER, 5, undefined);

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(5, undefined, undefined);
  });
});

describe('AdoController.getStates', () => {
  it('translates req2ado\'s internal category label to the project\'s real work-item type name before calling readStates', async () => {
    // Confirmed real bug: the wizard sends "Requirement" (req2ado's own
    // internal category label) as workItemType -- previously forwarded
    // straight to ADO, which 404s on any non-CMMI process template. An
    // Agile project's real Requirement-category type is "User Story".
    const mcpClient = {
      discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' }),
      readStates: jest.fn().mockResolvedValue(['New', 'Active', 'Resolved', 'Closed']),
    };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    const result = await controller.getStates(TEST_USER, 'Requirement', 'AgileProject');

    expect(mcpClient.discoverWorkItemTypeCategories).toHaveBeenCalledWith('AgileProject', TEST_CREDENTIAL);
    expect(mcpClient.readStates).toHaveBeenCalledWith('User Story', 'AgileProject', TEST_CREDENTIAL);
    expect(result).toEqual(['New', 'Active', 'Resolved', 'Closed']);
  });

  it('falls back to the raw workItemType when it is not one of the 3 known categories', async () => {
    const mcpClient = {
      discoverWorkItemTypeCategories: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' }),
      readStates: jest.fn().mockResolvedValue(['Active']),
    };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    await controller.getStates(TEST_USER, 'Bug', undefined);

    expect(mcpClient.readStates).toHaveBeenCalledWith('Bug', undefined, TEST_CREDENTIAL);
  });
});

describe('AdoController.getStatus', () => {
  it('returns not_configured when the caller has no vaulted credential', async () => {
    const controller = new AdoController({} as any, fakeResolver(undefined, false) as any);

    const result = await controller.getStatus(TEST_USER);

    expect(result).toEqual({ status: 'not_configured' });
  });

  it('returns valid when discoverProjects succeeds', async () => {
    const mcpClient = { discoverProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Project' }]) };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    const result = await controller.getStatus(TEST_USER);

    expect(mcpClient.discoverProjects).toHaveBeenCalledWith(TEST_CREDENTIAL);
    expect(result).toEqual({ status: 'valid' });
  });

  it('returns unreachable when discoverProjects rejects for a reason that is not a rejected credential', async () => {
    const mcpClient = { discoverProjects: jest.fn().mockRejectedValue(new Error('boom')) };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    const result = await controller.getStatus(TEST_USER);

    expect(result).toEqual({ status: 'unreachable' });
  });

  describe('tells a rejected credential from an unreachable server', () => {
    const statusFor = async (message: string) => {
      const mcpClient = { discoverProjects: jest.fn().mockRejectedValue(new Error(message)) };
      return new AdoController(mcpClient as any, fakeResolver() as any).getStatus(TEST_USER);
    };

    it.each([
      'ADO wit/fields api-version probe failed: 401 at https://dev.azure.com/org/_apis/wit/fields',
      'ADO wit/fields api-version probe failed: 403 at https://dev.azure.com/org/_apis/wit/fields',
      'ADO REST request to ado_discover_projects failed with status 401',
      'Request failed with status code 403',
    ])('a 401 or 403 means the saved credential is not accepted: %s', async (message) => {
      expect(await statusFor(message)).toEqual({ status: 'invalid' });
    });

    it.each([
      'ADO wit/fields api-version probe failed: 500 at https://dev.azure.com/org/_apis/wit/fields',
      'ADO wit/fields api-version probe failed: getaddrinfo ENOTFOUND dev.azure.com at https://dev.azure.com/org/_apis/wit/fields',
      'ADO wit/fields api-version probe failed: unable to verify the first certificate at https://ado.example/_apis/wit/fields',
      'connect ECONNREFUSED 127.0.0.1:3000',
      'ADO wit/fields api-version probe failed: 4011 at https://x',
      'ADO wit/fields api-version probe failed: 404 at https://x',
    ])('anything else stays unreachable, so a network or certificate problem is never called a bad credential: %s', async (message) => {
      expect(await statusFor(message)).toEqual({ status: 'unreachable' });
    });

    it('a timeout is unreachable', async () => {
      const mcpClient = { discoverProjects: jest.fn().mockRejectedValue(Object.assign(new Error('timed out after 30000ms'), { name: 'McpRequestTimeoutError' })) };

      expect(await new AdoController(mcpClient as any, fakeResolver() as any).getStatus(TEST_USER)).toEqual({ status: 'unreachable' });
    });
  });
});

describe('AdoController.getProjects', () => {
  it('resolves the credential from the vault by session userId and returns the project list', async () => {
    const mcpClient = {
      discoverProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Project' }]),
    };
    const resolver = fakeResolver();
    const controller = new AdoController(mcpClient as any, resolver as any);

    const result = await controller.getProjects(TEST_USER);

    expect(resolver.resolve).toHaveBeenCalledWith(TEST_USER.userId);
    expect(mcpClient.discoverProjects).toHaveBeenCalledWith(TEST_CREDENTIAL);
    expect(result).toEqual([{ id: '1', name: 'Project' }]);
  });
});

// Owner finding (2026-11-26): the new-job tree must show the project's real Azure DevOps type icons, as the review tree does.
describe('AdoController work-item types', () => {
  const catalogService = {
    resolve: jest.fn().mockResolvedValue({ Epic: { color: 'FF7B00', iconDataUrl: 'data:image/svg+xml;base64,AAA' } }),
    resolveCategoryLabels: jest.fn().mockResolvedValue({ Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' }),
  };

  it('answers the project type catalog and category labels, read with the user own credential', async () => {
    const credential = { orgUrl: 'https://dev.azure.com/x', pat: 'p' };
    const resolver = { resolve: jest.fn().mockResolvedValue(credential) };
    const controller = new AdoController({} as any, resolver as any, catalogService as any);
    const result = await controller.getWorkItemTypes({ userId: 'u1', displayName: 'U' }, 'Vireo');
    expect(resolver.resolve).toHaveBeenCalledWith('u1');
    expect(catalogService.resolve).toHaveBeenCalledWith('Vireo', credential);
    expect(result).toEqual({
      catalog: { Epic: { color: 'FF7B00', iconDataUrl: 'data:image/svg+xml;base64,AAA' } },
      labels: { Epic: 'Epic', Feature: 'Feature', Requirement: 'User Story' },
    });
  });

  it('fails open to an empty catalog: no project, no credential, or a failed read never breaks the new-job page', async () => {
    const empty = { catalog: {}, labels: { Epic: 'Epic', Feature: 'Feature', Requirement: 'Requirement' } };
    const none = new AdoController({} as any, { resolve: jest.fn().mockResolvedValue(null) } as any, catalogService as any);
    expect(await none.getWorkItemTypes({ userId: 'u1', displayName: 'U' }, 'Vireo')).toEqual(empty);
    expect(await none.getWorkItemTypes({ userId: 'u1', displayName: 'U' }, undefined)).toEqual(empty);
    const failing = { resolve: jest.fn().mockRejectedValue(new Error('boom')), resolveCategoryLabels: jest.fn().mockRejectedValue(new Error('boom')) };
    const broken = new AdoController({} as any, { resolve: jest.fn().mockResolvedValue({ orgUrl: 'o', pat: 'p' }) } as any, failing as any);
    expect(await broken.getWorkItemTypes({ userId: 'u1', displayName: 'U' }, 'Vireo')).toEqual(empty);
  });
});
