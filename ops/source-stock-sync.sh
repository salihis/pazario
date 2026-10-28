#!/usr/bin/env bash
set -euo pipefail

MARKETPLACE="${1:?marketplace is required}"
LIMIT="${2:?limit is required}"
SOURCE_ID="${3:?source id is required}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-pazario-deploy-backend-1}"

case "$MARKETPLACE" in
  TRENDYOL|N11|PAZARAMA|HEPSIBURADA) ;;
  *) echo "Unsupported marketplace: $MARKETPLACE" >&2; exit 2 ;;
esac

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || (( LIMIT < 1 || LIMIT > 1000 )); then
  echo "Limit must be between 1 and 1000." >&2
  exit 2
fi

token="$(docker exec "$BACKEND_CONTAINER" node -e '
const jwt = require("jsonwebtoken");
const fs = require("fs");
const key = fs.readFileSync(process.env.JWT_PRIVATE_KEY_FILE);
process.stdout.write(jwt.sign(
  { id: "source-stock-sync", email: "source-stock-sync@pazario.local", role: "ADMIN" },
  key,
  { algorithm: "RS256", expiresIn: "5m" }
));
')"

payload="$(printf '{"dryRun":false,"limit":%s,"sourceId":"%s"}' "$LIMIT" "$SOURCE_ID")"
docker exec "$BACKEND_CONTAINER" curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  "http://localhost:3000/api/marketplace-listings/stock-sync?marketplace=$MARKETPLACE" \
  -d "$payload"
printf '\n'
