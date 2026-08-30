import { readFileSync } from 'fs';
import { join } from 'path';
import { ALLOWED_EXTENSIONS } from '../src/modules/pipeline/jobs.controller';

// Mechanical drift guard for the subset relationship documented in
// jobs.controller.ts's own comment on ALLOWED_EXTENSIONS: job creation is a
// deliberate subset of ingestion/app/dispatch.py's own _SUPPORTED_EXTENSIONS
// (the KB ingest path's gate, which accepts a wider format range). A prior
// audit found this relationship had gone undocumented and the comment
// claiming parity was stale/false -- this test is the guard that convention
// lacked, so if ingestion ever DROPS support for one of the 5 job-creation
// extensions without updating this file (or vice versa, someone narrows
// ALLOWED_EXTENSIONS to something ingestion no longer has a loader for),
// this fails loudly instead of surfacing as a silent 400 in production.
const DISPATCH_PATH = join(__dirname, '../../ingestion/app/dispatch.py');

function parsePythonExtensionSet(source: string, variableName: string): Set<string> {
  const pattern = new RegExp(`${variableName}\\s*=\\s*\\{([^}]*)\\}`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Could not find ${variableName} in dispatch.py`);
  const extensions = new Set<string>();
  for (const literal of match[1].matchAll(/"(\.[a-z0-9]+)"/g)) {
    extensions.add(literal[1]);
  }
  return extensions;
}

describe('ALLOWED_EXTENSIONS drift guard', () => {
  it('is a subset of ingestion dispatch.py\'s _SUPPORTED_EXTENSIONS (excluding images)', () => {
    const dispatchSource = readFileSync(DISPATCH_PATH, 'utf-8');
    const imageExtensions = parsePythonExtensionSet(dispatchSource, '_IMAGE_EXTENSIONS');
    const supportedExtensions = parsePythonExtensionSet(dispatchSource, '_SUPPORTED_EXTENSIONS');
    // _SUPPORTED_EXTENSIONS' own literal only spells out the non-image
    // extensions directly and splices _IMAGE_EXTENSIONS in via `*` -- the
    // regex above can't see through that splice, so the image set has to be
    // unioned in here to reconstruct the real full set.
    const fullIngestionSet = new Set([...supportedExtensions, ...imageExtensions]);

    const missing = [...ALLOWED_EXTENSIONS].filter((ext) => !fullIngestionSet.has(ext));
    expect(missing).toEqual([]);
  });
});
