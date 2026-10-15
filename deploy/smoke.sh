#!/bin/sh
# Builds the image, starts deploy/compose.yml from scratch and walks the first
# minutes of a self-hosted server: setup, admin sign-up, a project, the
# dashboard. SMOKE_STORAGE=1 adds compose.storage.yml and uploads an
# attachment the way a browser does. Used by CI; safe to run locally (it
# tears everything down).
set -eu
cd "$(dirname "$0")"
project="orchestrat-smoke-$$"
files="-f compose.yml"
if [ "${SMOKE_STORAGE:-0}" = 1 ]; then
  files="$files -f compose.storage.yml"
  export S3_PORT="${SMOKE_S3_PORT:-18333}"
  export ORCHESTRAT_S3_PUBLIC_ENDPOINT="http://localhost:$S3_PORT"
fi
# shellcheck disable=SC2086
compose() { docker compose -p "$project" $files "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env.smoke
}
trap cleanup EXIT

compose build orchestrat
compose run --rm --no-deps -T orchestrat init > .env.smoke

export $(grep -E '^(POSTGRES_PASSWORD|ORCHESTRAT_SETUP_TOKEN)=' .env.smoke | xargs)
port="${SMOKE_PORT:-18801}"
export ORCHESTRAT_ENV_FILE=.env.smoke ORCHESTRAT_PORT="$port"
compose --env-file .env.smoke up -d --wait
base="http://127.0.0.1:$port"
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }

curl -fsS "$base/ready" >/dev/null
test "$(curl -fsS "$base/api/v1/auth/instance" | json .needs_setup)" = "true"
curl -fsS "$base/" | grep -q '<div id="root"'
curl -fsS "$base/projects/anything" | grep -q '<div id="root"'

session=$(curl -fsS -X POST "$base/api/v1/auth/signup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"admin@example.test\",\"password\":\"smoke-test-passphrase\",\"full_name\":\"Smoke\",\"setup_token\":\"$ORCHESTRAT_SETUP_TOKEN\"}")
access=$(printf %s "$session" | json .access_token)
test "$(printf %s "$session" | json .user.is_instance_admin)" = "true"
auth="authorization: Bearer $access"

organization=$(curl -fsS -X POST "$base/api/v1/organizations" -H "$auth" \
  -H 'content-type: application/json' -d '{"name":"Smoke"}' | json .id)
project_id=$(curl -fsS -X POST "$base/api/v1/organizations/$organization/projects" \
  -H "$auth" -H 'content-type: application/json' -d '{"name":"Smoke"}' \
  | json .id)

if [ "${SMOKE_STORAGE:-0}" = 1 ]; then
  document=$(curl -fsS -X POST "$base/api/v1/projects/$project_id/documents" \
    -H "$auth" -H 'content-type: application/json' \
    -d '{"path":"notes/smoke.md","content":"# Smoke\n"}' | json .document.id)
  upload=$(curl -fsS -X POST "$base/api/v1/documents/$document/attachments/uploads" \
    -H "$auth" -H 'content-type: application/json' \
    -d '{"filename":"hello.txt","content_type":"text/plain","size_bytes":5}')
  upload_url=$(printf %s "$upload" | json .upload.upload_url)
  upload_id=$(printf %s "$upload" | json .upload.id)
  # Signed for the public endpoint, not the server's internal one.
  case "$upload_url" in
    "$ORCHESTRAT_S3_PUBLIC_ENDPOINT"/*) ;;
    *) echo "Upload URL is not on the public endpoint: $upload_url" >&2; exit 1 ;;
  esac
  printf hello | curl -fsS -X PUT -H 'content-type: text/plain' \
    --data-binary @- "$upload_url" >/dev/null
  curl -fsS -X POST "$base/api/v1/documents/$document/attachments/uploads/$upload_id/complete" \
    -H "$auth" -H 'content-type: application/json' -d '{"parts":[]}' >/dev/null
  test "$(curl -fsS "$base/api/v1/documents/$document/attachments" -H "$auth" \
    | json .attachments.length)" = "1"
fi

compose exec -T orchestrat orchestrat-admin list-users | grep -q admin@example.test
echo "Smoke test passed."
