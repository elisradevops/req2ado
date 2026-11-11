import { describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';
import { driveMismatchOf } from './kbDriveMismatch';

function conflict(data: unknown, status = 409): AxiosError {
  return new AxiosError('conflict', 'ERR_BAD_REQUEST', undefined, undefined, { status, data } as never);
}

describe('driveMismatchOf', () => {
  it('reads the counts from the server\'s kb_drive_mismatch answer', () => {
    expect(driveMismatchOf(conflict({ code: 'kb_drive_mismatch', otherDriveDocuments: 3, unknownDriveDocuments: 1 }))).toEqual({ otherDrive: 3, unknownDrive: 1 });
  });

  it('treats a missing count as zero', () => {
    expect(driveMismatchOf(conflict({ code: 'kb_drive_mismatch', otherDriveDocuments: 2 }))).toEqual({ otherDrive: 2, unknownDrive: 0 });
  });

  it.each([
    ['another conflict', conflict({ code: 'kb_batch_active' })],
    ['another status', conflict({ code: 'kb_drive_mismatch' }, 500)],
    ['a body with no code', conflict({ message: 'nope' })],
    ['an error that is not an HTTP one', new Error('boom')],
    ['something that is not an error', 'kb_drive_mismatch'],
  ])('is null for %s', (_label, error) => {
    expect(driveMismatchOf(error)).toBeNull();
  });
});
