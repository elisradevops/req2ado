import { describe, it, expect } from 'vitest';
import { buildWorkItemUrl } from './adoLinks';

describe('buildWorkItemUrl', () => {
  it('includes the project segment when a project is given', () => {
    expect(buildWorkItemUrl('https://dev.azure.com/example-org', 'MyProject', 532)).toBe(
      'https://dev.azure.com/example-org/MyProject/_workitems/edit/532',
    );
  });

  it('falls back to the org-only global redirect form when project is null/undefined', () => {
    expect(buildWorkItemUrl('https://dev.azure.com/example-org', null, 532)).toBe(
      'https://dev.azure.com/example-org/_workitems/edit/532',
    );
    expect(buildWorkItemUrl('https://dev.azure.com/example-org', undefined, 532)).toBe(
      'https://dev.azure.com/example-org/_workitems/edit/532',
    );
  });

  it('URL-encodes a project name with spaces/special characters', () => {
    expect(buildWorkItemUrl('https://dev.azure.com/example-org', 'My Project & Co', 532)).toBe(
      'https://dev.azure.com/example-org/My%20Project%20%26%20Co/_workitems/edit/532',
    );
  });
});
