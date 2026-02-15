#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-https://api.momentumfirmfinance.com}"
ROLE="${ROLE:-CFO}"

echo "== health =="
curl -sS "${API_BASE_URL}/health" | jq .

echo "== debug/status =="
curl -sS -H "X-User-Role: ${ROLE}" "${API_BASE_URL}/debug/status" | jq .

echo "== periods (RBAC header required) =="
curl -sS -H "X-User-Role: ${ROLE}" "${API_BASE_URL}/periods" | jq .

echo "== chat session =="
SESSION_JSON="$(curl -sS -X POST -H "X-User-Role: CFO" -H "Content-Type: application/json" "${API_BASE_URL}/chat/session" -d '{}')"
echo "${SESSION_JSON}" | jq .
SESSION_ID="$(echo "${SESSION_JSON}" | jq -r '.session_id')"

echo "== chat message =="
curl -sS -X POST -H "X-User-Role: CFO" -H "Content-Type: application/json" "${API_BASE_URL}/chat/message" -d "{\"session_id\":\"${SESSION_ID}\",\"message\":\"Explain ROA\"}" | jq .

echo "== export job create/status =="
JOB_JSON="$(curl -sS -X POST -H "X-User-Role: CFO" "${API_BASE_URL}/exports/board-pack/jobs")"
echo "${JOB_JSON}" | jq .
JOB_ID="$(echo "${JOB_JSON}" | jq -r '.job_id')"
for i in {1..20}; do
  STATUS_JSON="$(curl -sS -H "X-User-Role: CFO" "${API_BASE_URL}/exports/board-pack/jobs/${JOB_ID}")"
  STATUS="$(echo "${STATUS_JSON}" | jq -r '.status')"
  echo "job status: ${STATUS}"
  if [[ "${STATUS}" == "completed" || "${STATUS}" == "failed" ]]; then
    echo "${STATUS_JSON}" | jq .
    break
  fi
  sleep 1
done

echo "== done =="
