import { describe, it, expect } from 'vitest';
import { redactSharingUrl } from './redactSharingUrl';

describe('redactSharingUrl', () => {
  it('drops the query string and hash, where a sharing token often sits', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/sites/Team/Shared%20Documents?e=AbC123xyz&csf=1#top')).toBe(
      'https://contoso.sharepoint.com/sites/Team/Shared%20Documents',
    );
  });

  it('replaces an opaque token segment of a sharing link with an ellipsis, keeping the readable parts', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/:f:/s/Team/EqAbC123dEf456GhI789jKl?e=zzz')).toBe('https://contoso.sharepoint.com/:f:/s/Team/…');
    expect(redactSharingUrl('https://1drv.ms/f/s!AbCdEfGhIjKlMnOp123456')).toBe('https://1drv.ms/f/…');
  });

  it('keeps ordinary short or all-letter path words', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/sites/Engineering/Documents')).toBe('https://contoso.sharepoint.com/sites/Engineering/Documents');
  });

  it('never returns a token even when the value is not a URL', () => {
    expect(redactSharingUrl('not a url?token=SECRET123')).toBe('not a url');
    expect(redactSharingUrl('')).toBe('');
  });

  it('shows just the origin for a bare host', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/')).toBe('https://contoso.sharepoint.com');
  });
  it('redacts a sharing link\'s token by where it is, so a token with no digits is still hidden and a readable site name is kept', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/:f:/s/Team/EhQwErTyUiOpAsDfGhJkLzXcVbNm')).toBe('https://contoso.sharepoint.com/:f:/s/Team/…');
    expect(redactSharingUrl('https://contoso.sharepoint.com/:f:/s/Project2024Requirements/EhQwErTyUiOpAsDfGhJkLzXcVbNm?e=x')).toBe(
      'https://contoso.sharepoint.com/:f:/s/Project2024Requirements/…',
    );
    expect(redactSharingUrl('https://contoso-my.sharepoint.com/:f:/g/personal/jane_contoso_com/EqAbC123dEf456GhI789jKl%3D')).toBe(
      'https://contoso-my.sharepoint.com/:f:/g/personal/jane_contoso_com/…',
    );
  });

  it('leaves a direct folder path alone (the "r" form names a folder, it is not a token)', () => {
    expect(redactSharingUrl('https://contoso.sharepoint.com/:f:/r/sites/Team/Shared%20Documents/Customer%20Requirements?csf=1')).toBe(
      'https://contoso.sharepoint.com/:f:/r/sites/Team/Shared%20Documents/Customer%20Requirements',
    );
  });
});
