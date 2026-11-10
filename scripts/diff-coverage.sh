#!/usr/bin/env bash
# Changed-line coverage gate: every package whose source changed relative to
# $COVERAGE_BASE (default HEAD, i.e. the phase's uncommitted work including
# new untracked files) must have >= $COVERAGE_THRESHOLD % (default 80) of its
# changed, executable source lines covered by that package's own test suite.
#
# Usage: scripts/diff-coverage.sh [package ...]
#   packages: frontend orchestrator mcp-ado-server ingestion
#   no arguments = every package with changed source lines
#
# Environment:
#   COVERAGE_THRESHOLD   minimum percent (default 80)
#   COVERAGE_BASE        git ref the diff is taken against (default HEAD)
#   COVERAGE_OUT         scratch dir for reports (default $TMPDIR/req2ado-cov)
#   COVERAGE_REUSE=1     reuse an existing lcov report instead of re-running tests
#                        (rejected if any changed SOURCE file is newer than the
#                        report; an edited TEST file is not detected, so never
#                        use this for a final gate run)
#   DIFF_COVER           diff-cover executable (default ingestion/.venv/bin/diff-cover)
#   PY                   python used for the report math and ingestion tests
#                        (default ingestion/.venv/bin/python)
#
# Prerequisites: `pnpm install` at the repo root, and the ingestion virtualenv
# with its dev extras (`pip install -e ".[dev]"` in ingestion/), because
# diff-cover and the threshold check run from that venv even for TS-only runs.
#
# A changed source file that is missing from the coverage report FAILS the
# gate: diff-cover would otherwise ignore it silently and an untested new
# file would pass. Test files, type declarations and generated code are not
# counted as source. shared/ts is not measured (generated types only).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

THRESHOLD="${COVERAGE_THRESHOLD:-80}"
BASE="${COVERAGE_BASE:-HEAD}"
OUT="${COVERAGE_OUT:-${TMPDIR:-/tmp}/req2ado-cov}"
DIFF_COVER="${DIFF_COVER:-$ROOT/ingestion/.venv/bin/diff-cover}"
PY="${PY:-$ROOT/ingestion/.venv/bin/python}"

ALL_PKGS="frontend orchestrator mcp-ado-server ingestion"

# Pathspecs (one per line) naming a package's measurable source files.
source_pathspecs() {
  case "$1" in
    frontend)
      printf '%s\n' ':(glob)frontend/src/**/*.ts' ':(glob)frontend/src/**/*.tsx' \
        ':(exclude,glob)frontend/src/**/*.test.ts' ':(exclude,glob)frontend/src/**/*.test.tsx' \
        ':(exclude,glob)frontend/src/**/*.d.ts' ':(exclude,glob)frontend/src/test/**' \
        ':(exclude,glob)frontend/src/**/generated/**' ;;
    orchestrator)
      printf '%s\n' ':(glob)orchestrator/src/**/*.ts' ':(exclude,glob)orchestrator/src/**/*.spec.ts' \
        ':(exclude,glob)orchestrator/src/**/*.d.ts' ;;
    mcp-ado-server)
      printf '%s\n' ':(glob)mcp-ado-server/src/**/*.ts' ':(exclude,glob)mcp-ado-server/src/**/*.d.ts' ;;
    ingestion)
      printf '%s\n' ':(glob)ingestion/app/**/*.py' ;;
    *) echo "unknown package: $1" >&2; return 1 ;;
  esac
}

# Writes a unified diff (zero context) of the package's source changes,
# tracked and untracked, to $2. Never touches the git index.
make_diff() {
  local pkg="$1" out="$2" specs=() line f
  # Explicit prefixes: a user/CI git config (diff.noprefix, diff.mnemonicPrefix)
  # must not change the `a/` `b/` paths the rest of this script parses.
  # core.quotePath=false keeps non-ASCII file names unquoted in diff headers.
  local gd=(git -c core.quotePath=false diff --no-color --no-ext-diff -U0 --src-prefix=a/ --dst-prefix=b/)
  local untracked
  while IFS= read -r line; do specs+=("$line"); done < <(source_pathspecs "$pkg")
  : > "$out"
  # A failing tracked diff (bad ref, git error) must NOT look like "no changes".
  "${gd[@]}" "$BASE" -- "${specs[@]}" >> "$out" || { echo "$pkg: git diff against $BASE failed" >&2; return 1; }
  # Captured first (not process substitution) so a git failure is not ignored.
  untracked="$(git -c core.quotePath=false ls-files --others --exclude-standard -- "${specs[@]}")" \
    || { echo "$pkg: git ls-files failed" >&2; return 1; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # --no-index exits 1 whenever the files differ; that is the normal case.
    "${gd[@]}" --no-index /dev/null "$f" >> "$out" || true
  done <<< "$untracked"
}

changed_files() { # file list from a diff produced by make_diff
  # awk (not sed \t, which BSD sed lacks): git appends a tab after paths with spaces.
  awk '/^\+\+\+ b\// { sub(/^\+\+\+ b\//, ""); sub(/\t$/, ""); print }' "$1" | sort -u
}

run_coverage() { # $1 package -> writes $OUT/$1/lcov.info (raw)
  local pkg="$1" dir="$OUT/$1"
  mkdir -p "$dir"
  case "$pkg" in
    frontend|mcp-ado-server)
      pnpm --filter "./$pkg" exec vitest run --coverage --coverage.provider=v8 \
        --coverage.reporter=lcov --coverage.reportsDirectory="$dir" \
        --coverage.include='src/**' --coverage.all=true ;;
    orchestrator)
      pnpm --filter "./$pkg" exec jest --coverage --coverageReporters=lcovonly \
        --coverageDirectory="$dir" --collectCoverageFrom='src/**/*.ts' \
        --collectCoverageFrom='!src/**/*.spec.ts' --collectCoverageFrom='!src/**/*.d.ts' ;;
    ingestion)
      # REDIS_URL points at a dead port so the (fail-open) LLM response cache
      # behaves as in CI; with a local Redis up, cached results from earlier
      # runs change what some tests observe. COVERAGE_FILE keeps the data
      # file out of the working tree. `;` not `&&`: lcov is written even when
      # a test fails, because test-green is checked by the full-suite step,
      # not by this gate.
      ( cd ingestion && export REDIS_URL=redis://127.0.0.1:1 COVERAGE_FILE="$dir/.coverage"
        "$PY" -m pytest -q -p no:cacheprovider --cov=app --cov-report= ; rc=$?
        "$PY" -m coverage lcov -o "$dir/lcov.info"; exit "$rc" ) ;;
  esac
}

# Rewrites SF: paths to be repo-root-relative so diff paths and coverage
# paths agree across packages that all have a src/ directory.
normalise_lcov() { # $1 package, $2 raw lcov, $3 output
  awk -v pkg="$1" -v root="$ROOT/" '
    /^SF:/ {
      p = substr($0, 4)
      if (index(p, root) == 1) p = substr(p, length(root) + 1)
      else if (substr(p, 1, 1) != "/") p = pkg "/" p
      print "SF:" p; next
    }
    { print }' "$2" > "$3"
}

gate_package() { # $1 package; echoes a result line; returns 0 pass, 1 fail
  local pkg="$1" diff="$OUT/$1.diff" raw="$OUT/$1/lcov.info" norm="$OUT/$1.lcov" json="$OUT/$1.json"
  mkdir -p "$OUT/$pkg"
  make_diff "$pkg" "$diff" || { echo "$pkg: FAIL (could not compute the diff)"; return 1; }
  if [ ! -s "$diff" ]; then
    echo "$pkg: SKIP (no changed source lines)"; return 0
  fi
  if [ "${COVERAGE_REUSE:-0}" = "1" ] && [ -s "$raw" ]; then
    # A reused report is only valid if no changed file is newer than it.
    local sf
    while IFS= read -r sf; do
      if [ "$sf" -nt "$raw" ]; then
        echo "$pkg: FAIL (reused coverage report is older than $sf; rerun without COVERAGE_REUSE)"; return 1
      fi
    done < <(changed_files "$diff")
    echo "$pkg: NOTE reusing coverage report $raw"
  fi
  if [ "${COVERAGE_REUSE:-0}" != "1" ] || [ ! -s "$raw" ]; then
    rm -f "$raw"
    if ! run_coverage "$pkg" >"$OUT/$pkg.run.log" 2>&1; then
      # A failing test under coverage must not hide the measurement, but it
      # must not be silent either: green is verified by the full-suite step.
      echo "$pkg: WARNING test run exited non-zero (see $OUT/$pkg.run.log); coverage measured anyway"
    fi
  fi
  [ -s "$raw" ] || { echo "$pkg: FAIL (no lcov report at $raw; see $OUT/$pkg.run.log)"; return 1; }
  normalise_lcov "$pkg" "$raw" "$norm"

  local missing="" f
  while IFS= read -r f; do
    if ! grep -qxF -- "SF:$f" "$norm"; then
      # jest omits files that compile to no code (types only); accept those,
      # and only those, when the TypeScript compiler confirms it.
      case "$f" in
        *.ts|*.tsx)
          local trc=0
          node "$ROOT/scripts/ts-type-only.cjs" "$f" >/dev/null 2>&1 || trc=$?
          [ "$trc" -eq 0 ] && continue
          [ "$trc" -eq 2 ] && echo "$pkg: NOTE ts-type-only.cjs could not analyse $f (is typescript installed?)" >&2 ;;
      esac
      missing="$missing $f"
    fi
  done < <(changed_files "$diff")
  if [ -n "$missing" ]; then
    echo "$pkg: FAIL (changed source file(s) absent from the coverage report:$missing)"; return 1
  fi

  "$DIFF_COVER" "$norm" --diff-file "$diff" --json-report "$json" --fail-under 0 >/dev/null 2>&1 || {
    echo "$pkg: FAIL (diff-cover could not process the report)"; return 1; }
  "$PY" - "$json" "$THRESHOLD" "$pkg" <<'PYEOF'
import json, sys
j = json.load(open(sys.argv[1])); thr = float(sys.argv[2]); pkg = sys.argv[3]
n = j.get("total_num_lines", 0); pct = j.get("total_percent_covered", 0)
if n == 0:
    print(f"{pkg}: PASS (n/a: no changed line is executable/instrumented)"); sys.exit(0)
bad = {f: v["violation_lines"] for f, v in j["src_stats"].items() if v["violation_lines"]}
ok = pct >= thr
print(f"{pkg}: {'PASS' if ok else 'FAIL'} {pct}% of {n} changed lines covered (min {thr:g}%)"
      + ("" if ok else f"; uncovered: {bad}"))
sys.exit(0 if ok else 1)
PYEOF
}

main() {
  mkdir -p "$OUT"
  [ -x "$DIFF_COVER" ] || { echo "diff-cover not found at $DIFF_COVER (pip install diff-cover in ingestion venv)" >&2; exit 2; }
  [ -x "$PY" ] || { echo "python not found at $PY (set PY or create the ingestion venv)" >&2; exit 2; }
  git rev-parse --verify -q "$BASE^{commit}" >/dev/null \
    || { echo "COVERAGE_BASE '$BASE' is not a commit" >&2; exit 2; }
  local pkgs="${*:-$ALL_PKGS}" rc=0 p
  for p in $pkgs; do
    case " $ALL_PKGS " in *" $p "*) ;; *) echo "unknown package: $p (expected: $ALL_PKGS)" >&2; exit 2 ;; esac
  done
  for p in $pkgs; do
    gate_package "$p" || rc=1
  done
  exit "$rc"
}
main "$@"
