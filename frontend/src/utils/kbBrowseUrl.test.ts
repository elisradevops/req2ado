import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LEGACY_KB_BROWSE_URL_KEY, clearKbBrowseUrl, kbBrowseUrlKey, readKbBrowseUrl, removeLegacyKbBrowseUrl, writeKbBrowseUrl } from './kbBrowseUrl';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('kbBrowseUrl', () => {
  it('keeps each user\'s last SharePoint folder under that user\'s own key', () => {
    writeKbBrowseUrl('user-a', 'https://share.example/a');
    writeKbBrowseUrl('user-b', 'https://share.example/b');
    expect(readKbBrowseUrl('user-a')).toBe('https://share.example/a');
    expect(readKbBrowseUrl('user-b')).toBe('https://share.example/b');
    expect(localStorage.getItem(kbBrowseUrlKey('user-a'))).toBe('https://share.example/a');
  });

  it('never reads the old global key: it belonged to whoever browsed last', () => {
    localStorage.setItem(LEGACY_KB_BROWSE_URL_KEY, 'https://share.example/someone-elses');
    expect(readKbBrowseUrl('user-a')).toBeNull();
  });

  it('does nothing without a user', () => {
    writeKbBrowseUrl(null, 'https://share.example/x');
    expect(localStorage.length).toBe(0);
    expect(readKbBrowseUrl(null)).toBeNull();
  });

  it('clears the user\'s key and the old global one, and only those', () => {
    writeKbBrowseUrl('user-a', 'https://share.example/a');
    writeKbBrowseUrl('user-b', 'https://share.example/b');
    localStorage.setItem(LEGACY_KB_BROWSE_URL_KEY, 'https://share.example/old');
    clearKbBrowseUrl('user-a');
    expect(readKbBrowseUrl('user-a')).toBeNull();
    expect(localStorage.getItem(LEGACY_KB_BROWSE_URL_KEY)).toBeNull();
    expect(readKbBrowseUrl('user-b')).toBe('https://share.example/b');
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readKbBrowseUrl('user-a')).toBeNull();
    expect(() => writeKbBrowseUrl('user-a', 'https://x')).not.toThrow();
    expect(() => clearKbBrowseUrl('user-a')).not.toThrow();
  });
  it('removes the old global key on its own (a link left by an earlier version), leaving every per-user key alone', () => {
    localStorage.setItem(LEGACY_KB_BROWSE_URL_KEY, 'https://share.example/old');
    writeKbBrowseUrl('user-a', 'https://share.example/a');
    removeLegacyKbBrowseUrl();
    expect(localStorage.getItem(LEGACY_KB_BROWSE_URL_KEY)).toBeNull();
    expect(readKbBrowseUrl('user-a')).toBe('https://share.example/a');
  });

  it('removing the old key survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => removeLegacyKbBrowseUrl()).not.toThrow();
  });
});
