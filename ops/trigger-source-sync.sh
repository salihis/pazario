#!/usr/bin/env bash
set -euo pipefail

SOURCE_ID="${1:?source id is required}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-pazario-deploy-backend-1}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-pazario-deploy-postgres-1}"

running_job="$({
  docker exec "$POSTGRES_CONTAINER" psql -U pazario -d pazario_db -Atc \
    "SELECT id FROM sync_jobs WHERE \"sourceId\" = '$SOURCE_ID'::uuid AND status IN ('PENDING', 'RUNNING') ORDER BY \"createdAt\" DESC LIMIT 1;"
} 2>/dev/null || true)"

if [[ -n "$running_job" ]]; then
  printf '{"success":true,"alreadyRunning":true,"syncJobId":"%s"}\n' "$running_job"
  exit 0
fi

token="$(docker exec "$BACKEND_CONTAINER" node -e '
const jwt = require("jsonwebtoken");
const fs = require("fs");
const key = fs.readFileSync(process.env.JWT_PRIVATE_KEY_FILE);
process.stdout.write(jwt.sign(
  { id: "xml-bridge", email: "xml-bridge@pazario.local", role: "ADMIN" },
  key,
  { algorithm: "RS256", expiresIn: "5m" }
));
')"

docker exec "$BACKEND_CONTAINER" curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $token" \
  "http://localhost:3000/api/sources/$SOURCE_ID/sync"
