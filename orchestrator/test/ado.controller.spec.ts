import { AdoController } from '../src/modules/pipeline/ado.controller';

describe('AdoController.getAreaPaths', () => {
  it('forwards headers as an AdoRequestCredential and returns the tree', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const controller = new AdoController(mcpClient as any);

    const result = await controller.getAreaPaths('https://ado.example', 'pat-123', 3, undefined);

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(3, undefined, { orgUrl: 'https://ado.example', pat: 'pat-123' });
    expect(result).toEqual({ path: 'Project', children: [] });
  });

  it('uses default depth of 5 when not provided', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const controller = new AdoController(mcpClient as any);

    const result = await controller.getAreaPaths('https://ado.example', 'pat-123', 5, undefined);

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(5, undefined, { orgUrl: 'https://ado.example', pat: 'pat-123' });
    expect(result).toEqual({ path: 'Project', children: [] });
  });

  it('forwards a project query param when provided', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'OtherProject', children: [] }) };
    const controller = new AdoController(mcpClient as any);

    await controller.getAreaPaths('https://ado.example', 'pat-123', 5, 'OtherProject');

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(5, 'OtherProject', {
      orgUrl: 'https://ado.example',
      pat: 'pat-123',
    });
  });
});

describe('AdoController.getProjects', () => {
  it('forwards headers as an AdoRequestCredential and returns the project list', async () => {
    const mcpClient = {
      discoverProjects: jest.fn().mockResolvedValue([{ id: '1', name: 'Project' }]),
    };
    const controller = new AdoController(mcpClient as any);

    const result = await controller.getProjects('https://ado.example', 'pat-123');

    expect(mcpClient.discoverProjects).toHaveBeenCalledWith({ orgUrl: 'https://ado.example', pat: 'pat-123' });
    expect(result).toEqual([{ id: '1', name: 'Project' }]);
  });
});
