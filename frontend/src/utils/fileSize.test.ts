import { describe, it, expect } from 'vitest';
import { formatFileSize } from './fileSize';

describe('formatFileSize', () => {
  it('renders sub-1024-byte sizes as bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('renders sub-10KB sizes with one decimal', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });

  it('renders 10KB-and-above sizes with no decimal', () => {
    expect(formatFileSize(15 * 1024)).toBe('15 KB');
  });

  it('renders sizes at or above 1MB in MB with one decimal', () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
