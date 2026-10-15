#!/bin/sh
# Builds the image, starts deploy/compose.yml from scratch and walks the first
# minutes of a self-hosted server: setup, admin sign-up, a project, the
# dashboard. Used by CI; safe to run locally (it tears everything down).
set -eu
cd "$(dirname "$0")"
project="orchestrat-smoke-$$"
compose() { docker compose -p "$project" "$@"; }
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
curl -fsS -X POST "$base/api/v1/organizations/$organization/projects" \
  -H "$auth" -H 'content-type: application/json' -d '{"name":"Smoke"}' \
  | json .id >/dev/null

compose exec -T orchestrat orchestrat-admin list-users | grep -q admin@example.test
echo "Smoke test passed."
