// shared/ts/scripts/generate.mjs
//
// Regenerates src/generated/*.ts from shared/schemas/*.schema.json (S10 —
// see each schema file's own "Single source of truth" doc comment). Run via
// `pnpm --filter @req2ado/shared-ts generate` after editing a schema; the
// committed output is checked for drift by test/generated.spec.ts, which
// fails if someone edited a schema (or the generated files by hand) without
// re-running this.
import { compile } from 'json-schema-to-typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, '../../schemas');
const outDir = path.resolve(here, '../src/generated');

const SCHEMAS = [
  { file: 'work-item-tree.schema.json', bannerComment: workItemTreeBanner() },
  { file: 'canonical-doc.schema.json', bannerComment: canonicalDocBanner() },
  { file: 'job-live.schema.json', bannerComment: sharedBanner('job-live.schema.json') },
];

function sharedBanner(schemaFile) {
  return (
    `/* eslint-disable */\n` +
    `/**\n` +
    ` * This file was automatically generated from shared/schemas/${schemaFile}.\n` +
    ` * DO NOT EDIT — run \`pnpm --filter @req2ado/shared-ts generate\` instead.\n` +
    ` */`
  );
}

function workItemTreeBanner() {
  return sharedBanner('work-item-tree.schema.json');
}

function canonicalDocBanner() {
  return sharedBanner('canonical-doc.schema.json');
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const { file, bannerComment } of SCHEMAS) {
    const schema = JSON.parse(await readFile(path.join(schemasDir, file), 'utf8'));
    const ts = await compile(schema, schema.title, {
      bannerComment,
      style: { singleQuote: true },
      additionalProperties: false,
    });
    const outFile = path.join(outDir, `${schema.title}.ts`);
    await writeFile(outFile, ts);
    // eslint-disable-next-line no-console -- build-time script, not app logging
    console.log(`generated ${path.relative(process.cwd(), outFile)}`);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console -- build-time script, not app logging
  console.error(error);
  process.exit(1);
});
