#!/usr/bin/env bash
# scripts/check-doc-coverage.sh — lists exported TS functions/classes with no
# preceding /** */ block, and exported Python functions/classes with no
# docstring. This is a CHECK, not an auto-fixer — read each finding and
# judge whether it genuinely needs documentation (non-obvious WHY) before
# adding anything, per this project's "no comments unless non-obvious" rule.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== TypeScript: exported symbols without a preceding /** doc block ==="
for dir in orchestrator/src mcp-ado-server/src frontend/src; do
  find "$dir" -name "*.ts" -o -name "*.tsx" | while read -r file; do
    grep -n "^export \(class\|function\|interface\)" "$file" | while IFS=: read -r lineno _; do
      prev_line=$((lineno - 1))
      prev_content=$(sed -n "${prev_line}p" "$file")
      if [[ "$prev_content" != *"*/"* ]]; then
        echo "$file:$lineno"
      fi
    done
  done
done

echo ""
echo "=== Python: public (non-underscore) functions/classes without a docstring ==="
for file in $(find ingestion/app -name "*.py"); do
  python3 -c "
import ast
import sys

with open('$file') as f:
    tree = ast.parse(f.read())

for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith('_'):
        if ast.get_docstring(node) is None:
            print(f'$file:{node.lineno}: {node.name}')
"
done
