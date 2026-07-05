#!/usr/bin/env bash
# orchestrator/scripts/run-load-test.sh
# Manual load test runner — not invoked by CI. Usage: ./scripts/run-load-test.sh [N]
set -euo pipefail
cd "$(dirname "$0")/.."
npx ts-node test/load/concurrentJobs.load-test.ts "${1:-50}"
