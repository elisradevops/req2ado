import { AdoController } from '../src/modules/pipeline/ado.controller';

describe('AdoController.getAreaPaths', () => {
  it('forwards headers as an AdoRequestCredential and returns the tree', async () => {
    const mcpClient = { readAreaPaths: jest.fn().mockResolvedValue({ path: 'Project', children: [] }) };
    const controller = new AdoController(mcpClient as any);

    const result = await controller.getAreaPaths('https://ado.example', 'pat-123', 3);

    expect(mcpClient.readAreaPaths).toHaveBeenCalledWith(3, { orgUrl: 'https://ado.example', pat: 'pat-123' });
    expect(result).toEqual({ path: 'Project', children: [] });
  });
});
