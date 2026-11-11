import { ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

// One knowledge base holds files from ONE SharePoint library (Graph "drive"). Vectors for a library nobody searches any more
// only cost storage, so adding from a different library is refused until the user has agreed to remove what is there.

export interface KbDriveConflict {
  // Documents recorded as coming from another library.
  otherDrive: number;
  // Documents with no recorded library (added before it was tracked): there is no telling whether they belong here.
  unknownDrive: number;
}

/** What in the user's knowledge base does not belong to `driveId`; null when everything does (or there is nothing). */
export async function findDriveConflict(prisma: Pick<PrismaClient, 'ingestedDocument'>, userId: string, driveId: string): Promise<KbDriveConflict | null> {
  const documents = await prisma.ingestedDocument.findMany({ where: { userId }, select: { driveId: true } });
  let otherDrive = 0;
  let unknownDrive = 0;
  for (const { driveId: recorded } of documents) {
    if (recorded === null || recorded === undefined) unknownDrive += 1;
    else if (recorded !== driveId) otherDrive += 1;
  }
  return otherDrive + unknownDrive === 0 ? null : { otherDrive, unknownDrive };
}

export class KbDriveMismatchException extends ConflictException {
  constructor(conflict: KbDriveConflict) {
    super({
      code: 'kb_drive_mismatch',
      message: 'Your knowledge base holds files from a different SharePoint library. Remove them before adding files from this one.',
      otherDriveDocuments: conflict.otherDrive,
      unknownDriveDocuments: conflict.unknownDrive,
    });
  }
}
