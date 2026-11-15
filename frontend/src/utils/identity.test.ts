import { describe, expect, it } from 'vitest';
import { initialsOf, serverOf, shortHandle } from './identity';

describe('initialsOf', () => {
  it.each([
    ['Jane Doe', 'JD'],
    ['Jane van der Berg', 'JB'],
    ['jane', 'J'],
    ['  Jane   Doe  ', 'JD'],
    ['דנה לוי', 'דל'],
    ['', '?'],
    [null, '?'],
  ])('%j -> %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});

describe('shortHandle', () => {
  it('is eight hex characters, the same every time for the same id, and different for a different one', () => {
    const a = shortHandle('Microsoft.TeamFoundation.Identity;S-1-5-21-000');

    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHandle('Microsoft.TeamFoundation.Identity;S-1-5-21-000')).toBe(a);
    expect(shortHandle('Microsoft.TeamFoundation.Identity;S-1-5-21-001')).not.toBe(a);
  });

  it('does not reveal the id', () => {
    expect(shortHandle('Microsoft.TeamFoundation.Identity;S-1-5-21-000')).not.toContain('S-1-5');
  });
});

describe('serverOf', () => {
  it('gives the server and the collection of an on-premises address', () => {
    expect(serverOf('https://tfs.corp.example/tfs/DefaultCollection')).toEqual({ host: 'tfs.corp.example', collection: 'tfs/DefaultCollection' });
  });

  it('gives just the host when there is no path', () => {
    expect(serverOf('https://dev.azure.com')).toEqual({ host: 'dev.azure.com', collection: null });
  });

  it('is null for something that is not an address', () => {
    expect(serverOf('not a url')).toBeNull();
    expect(serverOf(null)).toBeNull();
  });
});
