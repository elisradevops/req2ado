import { SettingsService } from '../src/modules/settings/settings.service';

describe('SettingsService', () => {
  it('get() returns the default dedupThreshold (0.90) when no row exists yet', async () => {
    const prisma = { appSettings: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new SettingsService(prisma as any);

    await expect(service.get()).resolves.toEqual({ dedupThreshold: 0.9 });
    expect(prisma.appSettings.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } });
  });

  it('get() returns the stored dedupThreshold when a row exists', async () => {
    const prisma = { appSettings: { findUnique: jest.fn().mockResolvedValue({ id: 'singleton', dedupThreshold: 0.75 }) } };
    const service = new SettingsService(prisma as any);

    await expect(service.get()).resolves.toEqual({ dedupThreshold: 0.75 });
  });

  it('update() upserts the singleton row and returns the new value', async () => {
    const prisma = { appSettings: { upsert: jest.fn().mockResolvedValue({ id: 'singleton', dedupThreshold: 0.8 }) } };
    const service = new SettingsService(prisma as any);

    await expect(service.update(0.8)).resolves.toEqual({ dedupThreshold: 0.8 });
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      create: { id: 'singleton', dedupThreshold: 0.8 },
      update: { dedupThreshold: 0.8 },
    });
  });

  it('get() also says which embedding model the similarity is measured with, read from configuration, when it is set', async () => {
    const prisma = { appSettings: { findUnique: jest.fn().mockResolvedValue(null) } };
    const config = { get: jest.fn((key: string) => (key === 'EMBED_MODEL' ? 'text-embedding-3-small' : undefined)) };
    const service = new SettingsService(prisma as any, config as any);

    await expect(service.get()).resolves.toEqual({ dedupThreshold: 0.9, embeddingModel: 'text-embedding-3-small' });
  });

  it('update() returns the model too, and never writes it: it is not something a user can change here', async () => {
    const prisma = { appSettings: { upsert: jest.fn().mockResolvedValue({ id: 'singleton', dedupThreshold: 0.8 }) } };
    const config = { get: jest.fn().mockReturnValue('text-embedding-3-small') };
    const service = new SettingsService(prisma as any, config as any);

    await expect(service.update(0.8)).resolves.toEqual({ dedupThreshold: 0.8, embeddingModel: 'text-embedding-3-small' });
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith({ where: { id: 'singleton' }, create: { id: 'singleton', dedupThreshold: 0.8 }, update: { dedupThreshold: 0.8 } });
  });

  describe('canEdit()', () => {
    const withAdmins = (value?: string) => new SettingsService({} as any, { get: jest.fn((key: string) => (key === 'REQ2ADO_ADMIN_USER_IDS' ? value : undefined)) } as any);

    it('lets everyone edit when no administrators are set (the behaviour before the setting existed)', () => {
      expect(withAdmins(undefined).canEdit('anyone')).toBe(true);
      expect(withAdmins('').canEdit('anyone')).toBe(true);
      expect(withAdmins('  ,  ').canEdit('anyone')).toBe(true);
      expect(new SettingsService({} as any).canEdit('anyone')).toBe(true);
    });

    it('lets only the listed users edit once any are set', () => {
      const service = withAdmins('user-a, user-b');

      expect(service.canEdit('user-a')).toBe(true);
      expect(service.canEdit('user-b')).toBe(true);
      expect(service.canEdit('user-c')).toBe(false);
    });

    it('matches the whole id: a longer or shorter id is not the listed one', () => {
      const service = withAdmins('user-a');

      expect(service.canEdit('user-a2')).toBe(false);
      expect(service.canEdit('user-')).toBe(false);
      expect(service.canEdit('USER-A')).toBe(false);
    });

    it('works with the long ids the app really uses (they contain a semicolon and an at sign)', () => {
      const id = 'Microsoft.IdentityModel.Claims.ClaimsIdentity;0003BFFEB6CC0DF6@Live.com';

      expect(withAdmins(`other, ${id}`).canEdit(id)).toBe(true);
    });

    it('an empty or missing user id is never an administrator once any are set', () => {
      expect(withAdmins('user-a').canEdit('')).toBe(false);
    });
  });
});
