import { isAxiosError } from 'axios';

// The server's answer when files are added from a different SharePoint library than the one the knowledge base already holds.
// Lives outside api/kb.ts so it reads the raw error the same way whatever the page mocks.

export interface DriveMismatch {
  // Documents recorded as coming from another library.
  otherDrive: number;
  // Documents added before the library was recorded: there is no telling whether they belong here.
  unknownDrive: number;
}

export function driveMismatchOf(error: unknown): DriveMismatch | null {
  if (!isAxiosError(error) || error.response?.status !== 409) return null;
  const data = error.response.data as { code?: unknown; otherDriveDocuments?: unknown; unknownDriveDocuments?: unknown } | undefined;
  if (data?.code !== 'kb_drive_mismatch') return null;
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return { otherDrive: count(data.otherDriveDocuments), unknownDrive: count(data.unknownDriveDocuments) };
}
