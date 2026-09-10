#!/bin/sh
set -eu

usage() {
  echo "usage: $0 --self-check | --run https://api.example.test <project-uuid> /absolute/evidence-dir" >&2
}

fail() {
  echo "acceptance: $*" >&2
  exit 1
}

snapshot_paths() {
  config_root=${ORCHESTRAT_ACCEPTANCE_CONFIG_ROOT:-$HOME}
  cat <<EOF
$config_root/.codex/config.toml
$config_root/.codex/hooks.json
$config_root/.claude.json
$config_root/.claude/settings.json
EOF
}

snapshot_files() {
  output=$1
  : >"$output"
  snapshot_paths | while IFS= read -r path; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      hash=$(shasum -a 256 "$path" | awk '{print $1}')
      printf '%s|%s\n' "$path" "$hash" >>"$output"
    else
      printf '%s|ABSENT\n' "$path" >>"$output"
    fi
  done
}

compare_snapshot() {
  baseline=$1
  current=$2
  snapshot_files "$current"
  cmp -s "$baseline" "$current"
}

self_check() {
  self_home=$(mktemp -d "${TMPDIR:-/tmp}/orchestrat-acceptance.XXXXXX")
  trap 'rm -rf "$self_home"' EXIT HUP INT TERM
  ORCHESTRAT_ACCEPTANCE_CONFIG_ROOT=$self_home
  export ORCHESTRAT_ACCEPTANCE_CONFIG_ROOT
  mkdir -p "$self_home/.codex" "$self_home/.claude"
  printf 'fixture = true\n' >"$self_home/.codex/config.toml"
  baseline="$self_home/baseline.txt"
  current="$self_home/current.txt"
  snapshot_files "$baseline"
  compare_snapshot "$baseline" "$current" || fail "self-check rejected unchanged fixture"
  printf 'changed\n' >>"$self_home/.codex/config.toml"
  if compare_snapshot "$baseline" "$current"; then
    fail "self-check accepted a changed fixture"
  fi
  echo "acceptance self-check: passed (temporary fixture only; no user configuration changed)"
}

run_acceptance() {
  api=$1
  project_id=$2
  evidence=$3

  case "$api" in
    https://*) ;;
    *) fail "API URL must use HTTPS" ;;
  esac
  [ "$(uname -s)" = "Darwin" ] || fail "this acceptance harness requires macOS"
  command -v node >/dev/null 2>&1 || fail "Node is required"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail "Node >=20 is required"
  command -v npx >/dev/null 2>&1 || fail "npx is required"
  command -v codex >/dev/null 2>&1 || fail "Codex executable is required"
  command -v claude >/dev/null 2>&1 || fail "Claude Code executable is required"
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  command -v shasum >/dev/null 2>&1 || fail "shasum is required"
  node -e '
    const value = process.argv[1];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) process.exit(1);
  ' "$project_id" || fail "project identifier must be a UUID"

  case "$evidence" in
    /*) ;;
    *) fail "evidence directory must be an absolute path" ;;
  esac
  [ ! -e "$evidence" ] || fail "evidence directory already exists: $evidence"
  (umask 077 && mkdir -p "$evidence")
  chmod 700 "$evidence"

  baseline="$evidence/config-baseline.txt"
  current="$evidence/config-current.txt"
  snapshot_files "$baseline"
  health_headers=$(mktemp "$evidence/health.headers.XXXXXX")
  if ! curl -fsS -D "$health_headers" -o /dev/null "${api%/}/health"; then
    rm -f "$health_headers"
    fail "API health check failed"
  fi
  request_id=$(awk 'tolower($1) == "x-request-id:" { gsub("\r", "", $2); print $2; exit }' "$health_headers")
  rm -f "$health_headers"
  [ -n "$request_id" ] || fail "API health response did not include x-request-id"
  printf 'health_request_id=%s\n' "$request_id" >"$evidence/request-ids.txt"
  printf 'project_id=%s\n' "$project_id" >"$evidence/context.txt"

  echo "Baseline captured in $evidence. Complete the real hosted-project checklist now."
  echo "Run: npx @orchestrat/cli@latest setup"
  printf 'Type SETUP_DONE after setup and the two-agent flow are complete: '
  IFS= read -r confirmation
  [ "$confirmation" = "SETUP_DONE" ] || fail "acceptance stopped before post-setup diagnostics"

  doctor_status=0
  ORCHESTRAT_API_URL="$api" orchestrat doctor >"$evidence/doctor.json" 2>/dev/null || doctor_status=$?
  {
    printf 'timestamp_utc=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'status=%s\n' "$doctor_status"
  } >"$evidence/doctor-meta.txt"
  [ "$doctor_status" -eq 0 ] || fail "orchestrat doctor failed; see doctor-meta.txt"

  echo "Run orchestrat disconnect all in the same terminal, then return here."
  printf 'Type DISCONNECT_DONE after disconnect completes: '
  IFS= read -r confirmation
  [ "$confirmation" = "DISCONNECT_DONE" ] || fail "acceptance stopped before preservation check"
  compare_snapshot "$baseline" "$current" \
    || fail "Codex/Claude configuration changed after disconnect"
  echo "Acceptance preservation check: passed"
}

case "${1-}" in
  --self-check)
    [ "$#" -eq 1 ] || { usage; exit 64; }
    self_check
    ;;
  --run)
    [ "$#" -eq 4 ] || { usage; exit 64; }
    run_acceptance "$2" "$3" "$4"
    ;;
  *)
    usage
    exit 64
    ;;
esac
