import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The proxy in front of the API and the assets (frontend/nginx.conf.template) compresses text responses: a job with 556 items is a 1.7 MB JSON
// document and nothing compressed it. The job event stream must NOT be compressed or buffered (SSE), so its type must never be in the list.
const template = readFileSync(join(__dirname, '..', '..', 'frontend', 'nginx.conf.template'), 'utf8');
const directive = (name: string): string | null => template.match(new RegExp(`^\\s*${name}\\s+([^;]+);`, 'm'))?.[1].trim() ?? null;

describe('nginx response compression', () => {
  it('turns gzip on for the server, with a minimum size and Vary', () => {
    expect(directive('gzip')).toBe('on');
    expect(directive('gzip_vary')).toBe('on');
    expect(Number(directive('gzip_min_length'))).toBeGreaterThanOrEqual(256);
  });

  it('compresses what is large and text: the API\'s JSON and the built assets', () => {
    const types = (directive('gzip_types') ?? '').split(/\s+/);
    for (const type of ['application/json', 'application/javascript', 'text/css']) expect(types).toContain(type);
  });

  it('compresses responses that came from the API upstream too (a proxied response is not skipped)', () => {
    expect(directive('gzip_proxied')).toBe('any');
  });

  it('never lists the event stream or an image type that is already compressed', () => {
    const types = (directive('gzip_types') ?? '').split(/\s+/);
    expect(types).not.toContain('text/event-stream');
    expect(types).not.toContain('image/png');
    expect(types).not.toContain('image/jpeg');
  });
});
