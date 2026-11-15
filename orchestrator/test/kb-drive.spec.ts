import { ConflictException } from '@nestjs/common';
import { KbDriveMismatchException, findDriveConflict } from '../src/modules/kb/kb-drive';

function prismaWithDocs(docs: { driveId: string | null }[]) {
  return { ingestedDocument: { findMany: jest.fn().mockResolvedValue(docs) } } as any;
}

describe('findDriveConflict()', () => {
  it('finds nothing when the knowledge base is empty', async () => {
    expect(await findDriveConflict(prismaWithDocs([]), 'u', 'drive-A')).toBeNull();
  });

  it('finds nothing when every document is from the same library', async () => {
    expect(await findDriveConflict(prismaWithDocs([{ driveId: 'drive-A' }, { driveId: 'drive-A' }]), 'u', 'drive-A')).toBeNull();
  });

  it('counts the documents from another library', async () => {
    const conflict = await findDriveConflict(prismaWithDocs([{ driveId: 'drive-A' }, { driveId: 'drive-B' }, { driveId: 'drive-B' }]), 'u', 'drive-A');

    expect(conflict).toEqual({ otherDrive: 2, unknownDrive: 0 });
  });

  it('counts documents with no recorded library separately: they were added before it was tracked', async () => {
    const conflict = await findDriveConflict(prismaWithDocs([{ driveId: null }, { driveId: null }, { driveId: 'drive-A' }, { driveId: 'drive-B' }]), 'u', 'drive-A');

    expect(conflict).toEqual({ otherDrive: 1, unknownDrive: 2 });
  });

  it('looks only at the given user, reading just the drive column', async () => {
    const prisma = prismaWithDocs([]);

    await findDriveConflict(prisma, 'user-7', 'drive-A');

    expect(prisma.ingestedDocument.findMany).toHaveBeenCalledWith({ where: { userId: 'user-7' }, select: { driveId: true } });
  });
});

describe('KbDriveMismatchException', () => {
  it('is a 409 whose body carries a stable code and both counts, so the page can explain it', () => {
    const error = new KbDriveMismatchException({ otherDrive: 3, unknownDrive: 1 });

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'kb_drive_mismatch', otherDriveDocuments: 3, unknownDriveDocuments: 1 });
  });
});
