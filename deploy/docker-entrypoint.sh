#!/bin/sh
# orchestrat [serve|admin|init] — the image's entrypoint.
set -e
command="${1:-serve}"
case "$command" in
  serve) exec node /app/apps/api/dist/server.js ;;
  admin) shift; exec node /app/apps/api/dist/admin.js "$@" ;;
  init) shift; exec node /app/apps/api/dist/init.js "$@" ;;
  *) exec "$@" ;;
esac
