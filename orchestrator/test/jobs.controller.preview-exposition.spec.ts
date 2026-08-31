import { JobsController } from '../src/modules/pipeline/jobs.controller';

const TEST_USER = { userId: 'user-1', displayName: 'User One' } as any;

describe('JobsController.previewExposition', () => {
  function makeController(documentOverviewService: any): JobsController {
    return new JobsController(
      {} as any, // jobsService
      {} as any, // ingestionClient
      {} as any, // clientFactory
      {} as any, // adoCredentialResolver
      {} as any, // workItemTypeCatalogService
      {} as any, // etaService
      1024 * 1024, // maxUploadSizeBytes
      documentOverviewService,
    );
  }

  it('returns the generated overview for valid input', async () => {
    const documentOverviewService = { generate: jest.fn().mockResolvedValue({ synopsis: 'About a backplane.', caveat: null }) };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition(
      TEST_USER,
      [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }],
      1,
      2,
    );

    expect(result).toEqual({ synopsis: 'About a backplane.', caveat: null });
    expect(documentOverviewService.generate).toHaveBeenCalledWith(
      {
        documentMap: [{ number: null, title: 'Intro', blockCount: 5, figureCount: 0 }],
        sectionCount: 1,
        depth: 2,
      },
      'user-1',
    );
  });

  it('returns null without calling the service when documentMap is missing', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition(TEST_USER, undefined, 1, 2);

    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });

  it('returns null without calling the service when sectionCount/depth are missing', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition(TEST_USER, [], undefined, undefined);

    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });

  it('returns null without calling the service when documentMap is truthy but not an array', async () => {
    const documentOverviewService = { generate: jest.fn() };
    const controller = makeController(documentOverviewService);

    const result = await controller.previewExposition(TEST_USER, { not: 'an array' } as any, 1, 2);

    expect(result).toBeNull();
    expect(documentOverviewService.generate).not.toHaveBeenCalled();
  });
});
