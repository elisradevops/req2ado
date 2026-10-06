// shared/ts/test/generated.spec.ts
//
// Drift guard: regenerates src/generated/*.ts from the checked-in schemas
// and asserts the output is byte-identical to what's committed. Catches two
// mistakes: editing a schema without re-running `pnpm generate`, and
// hand-editing a generated file directly (both violate the "single source
// of truth" contract each schema's own doc comment states).
import { describe, it, expect } from 'vitest';
import { compile } from 'json-schema-to-typescript';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, '../../schemas');
const generatedDir = path.resolve(here, '../src/generated');

function banner(schemaFile: string): string {
  return (
    `/* eslint-disable */\n` +
    `/**\n` +
    ` * This file was automatically generated from shared/schemas/${schemaFile}.\n` +
    ` * DO NOT EDIT — run \`pnpm --filter @req2ado/shared-ts generate\` instead.\n` +
    ` */`
  );
}

const SCHEMAS = [
  { schemaFile: 'work-item-tree.schema.json', generatedFile: 'WorkItemTree.ts' },
  { schemaFile: 'canonical-doc.schema.json', generatedFile: 'CanonicalDoc.ts' },
  { schemaFile: 'job-live.schema.json', generatedFile: 'JobLive.ts' },
];

describe('generated types match the checked-in schemas', () => {
  for (const { schemaFile, generatedFile } of SCHEMAS) {
    it(`${generatedFile} is a fresh regeneration of ${schemaFile}`, async () => {
      const schema = JSON.parse(await readFile(path.join(schemasDir, schemaFile), 'utf8'));
      const freshlyGenerated = await compile(schema, schema.title, {
        bannerComment: banner(schemaFile),
        style: { singleQuote: true },
        additionalProperties: false,
      });
      const committed = await readFile(path.join(generatedDir, generatedFile), 'utf8');
      expect(committed).toBe(freshlyGenerated);
    });
  }
});
