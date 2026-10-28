#!/usr/bin/env bash
set -euo pipefail

SOURCE_ID="${1:?source id is required}"
SYNC_JOB_ID="${2:?sync job id is required}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-pazario-deploy-postgres-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-1800}"
POLL_SECONDS="${POLL_SECONDS:-15}"

elapsed=0
while (( elapsed < MAX_WAIT_SECONDS )); do
  row="$(docker exec "$POSTGRES_CONTAINER" psql -U pazario -d pazario_db -At -F '|' -c \
    "SELECT status, COALESCE(\"totalProducts\", 0), COALESCE(\"changedProducts\", 0), COALESCE(\"failedCount\", 0), COALESCE(\"errorMessage\", '') FROM sync_jobs WHERE id = '$SYNC_JOB_ID'::uuid;")"
  status="${row%%|*}"

  if [[ "$status" == "DONE" ]]; then
    echo "Source sync completed: $row"
    break
  fi
  if [[ "$status" == "FAILED" || -z "$status" ]]; then
    echo "Source sync did not complete successfully: $row" >&2
    exit 1
  fi

  sleep "$POLL_SECONDS"
  elapsed=$((elapsed + POLL_SECONDS))
done

if (( elapsed >= MAX_WAIT_SECONDS )); then
  echo "Source sync timed out after $MAX_WAIT_SECONDS seconds." >&2
  exit 1
fi

while IFS='|' read -r marketplace count; do
  [[ -z "$marketplace" || "$count" == "0" ]] && continue
  remaining="$count"

  while (( remaining > 0 )); do
    limit=1000
    (( remaining < limit )) && limit="$remaining"
    response="$(bash "$SCRIPT_DIR/source-stock-sync.sh" "$marketplace" "$limit" "$SOURCE_ID")"
    RESPONSE="$response" EXPECTED="$limit" node -e '
const response = JSON.parse(process.env.RESPONSE || "{}");
const expected = Number(process.env.EXPECTED || 0);
if (!response.success || response.data?.scanned !== expected || response.data?.updated !== expected) {
  console.error(JSON.stringify(response));
  process.exit(1);
}
'
    remaining=$((remaining - limit))
    echo "$marketplace stock sync completed: $((count - remaining))/$count"
  done
done < <(docker exec "$POSTGRES_CONTAINER" psql -U pazario -d pazario_db -At -F '|' -c \
  "SELECT ml.marketplace, COUNT(*) FROM marketplace_listings ml JOIN products p ON p.id = ml.\"productId\" WHERE p.\"sourceId\" = '$SOURCE_ID'::uuid AND ml.status = 'PUBLISHED' GROUP BY ml.marketplace ORDER BY ml.marketplace;")

echo "Source and marketplace stock synchronization completed."
