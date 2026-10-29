#!/usr/bin/env node
// Exit 0 when the given TypeScript file compiles to no runtime code (only
// types/interfaces/re-exported types), 1 when it emits code, 2 on error.
// Used by diff-coverage.sh: jest drops such files from its lcov report, and
// that absence must not be confused with "a real source file nobody tested".
// Usage: node scripts/ts-type-only.cjs <repo-relative-file>
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('usage: ts-type-only.cjs <file>');
  process.exit(2);
}
try {
  const root = process.cwd();
  const pkgDir = path.join(root, file.split('/')[0]);
  const ts = require(require.resolve('typescript', { paths: [pkgDir, root] }));
  const out = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const code = out.replace(/export\s*\{\s*\}\s*;?/g, '').replace(/(["'])use strict\1\s*;?/g, '').trim();
  process.exit(code === '' ? 0 : 1);
} catch (err) {
  console.error(`ts-type-only: ${err.message}`);
  process.exit(2);
}
