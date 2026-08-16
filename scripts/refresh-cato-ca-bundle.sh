#!/usr/bin/env bash
# scripts/refresh-cato-ca-bundle.sh — regenerates .certs/cato-ca-bundle.pem.
#
# Dev-machine-only (see docs/design-decisions.md's "Notes" section): this
# bundle exists so orchestrator/mcp-ado-server can reach dev.azure.com from
# behind a Cato Networks-intercepting corporate network. It goes stale
# whenever Cato rotates its intercepting cert OR you're simply on a network
# path where Cato isn't intercepting and the real Microsoft/DigiCert chain
# needs to be trusted instead -- mcp-ado-server's real ADO client passes
# this file as the SOLE `ca:` trust anchor (not additive, unlike Node's
# NODE_EXTRA_CA_CERTS), so it must contain whatever chain is ACTUALLY live
# right now, not just the Cato root.
#
# Run this when real ADO API calls start failing with "unable to get local
# issuer certificate" (visible in `docker compose logs orchestrator` as an
# "ADO wit/fields api-version probe failed" error, or as a 500 from
# GET /ado/projects in the browser).
#
# What it does: takes Node's own built-in root CA store (145 well-known
# public roots -- covers the real Microsoft/DigiCert chain unconditionally)
# and appends the Cato Networks CA root pulled from this Mac's System
# keychain (covers the case where Cato IS actively intercepting). Verifies
# the result against the real dev.azure.com endpoint before overwriting.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE=".certs/cato-ca-bundle.pem"
TMP_NODE_ROOTS="$(mktemp)"
TMP_CATO_ROOT="$(mktemp)"
TMP_COMBINED="$(mktemp)"
trap 'rm -f "$TMP_NODE_ROOTS" "$TMP_CATO_ROOT" "$TMP_COMBINED"' EXIT

if ! docker compose ps mcp-ado-server --status running >/dev/null 2>&1 || \
   [[ -z "$(docker compose ps -q mcp-ado-server)" ]]; then
  echo "error: mcp-ado-server container must be running (docker compose up -d mcp-ado-server)" >&2
  exit 1
fi

echo "Extracting Node's built-in root CA store from mcp-ado-server..."
docker compose exec -T mcp-ado-server node -e "console.log(require('tls').rootCertificates.join('\n'))" > "$TMP_NODE_ROOTS"

echo "Extracting Cato Networks CA root from this Mac's System keychain..."
if ! security find-certificate -a -c "Cato Networks CA" -p /Library/Keychains/System.keychain > "$TMP_CATO_ROOT" 2>/dev/null \
   || [[ ! -s "$TMP_CATO_ROOT" ]]; then
  echo "warning: 'Cato Networks CA' not found in System keychain -- proceeding with Node's" \
       "built-in roots only. This is fine if Cato isn't currently intercepting; if it starts" \
       "intercepting again later, re-run this script once the cert is present." >&2
  : > "$TMP_CATO_ROOT"
fi

cat "$TMP_NODE_ROOTS" "$TMP_CATO_ROOT" > "$TMP_COMBINED"

echo "Verifying the combined bundle against the real dev.azure.com endpoint..."
VERIFY_CODE=$(openssl s_client -connect dev.azure.com:443 -CAfile "$TMP_COMBINED" </dev/null 2>&1 \
  | grep "Verify return code" | grep -o '[0-9]*' | head -1)
if [[ "$VERIFY_CODE" != "0" ]]; then
  echo "error: verification failed (code $VERIFY_CODE) -- bundle NOT updated. Run" \
       "'openssl s_client -connect dev.azure.com:443 -showcerts' manually to inspect the" \
       "current chain and adjust this script if the served chain has changed shape." >&2
  exit 1
fi

cp "$TMP_COMBINED" "$BUNDLE"
echo "Verified OK -- $BUNDLE refreshed ($(grep -c 'BEGIN CERTIFICATE' "$BUNDLE") certs)."
echo "Restart the services that read it: docker compose restart mcp-ado-server orchestrator pipeline-worker"
