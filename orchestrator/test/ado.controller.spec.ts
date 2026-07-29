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

  it('returns unreachable when discoverProjects rejects, for any reason', async () => {
    const mcpClient = { discoverProjects: jest.fn().mockRejectedValue(new Error('boom')) };
    const controller = new AdoController(mcpClient as any, fakeResolver() as any);

    const result = await controller.getStatus(TEST_USER);

    expect(result).toEqual({ status: 'unreachable' });
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
