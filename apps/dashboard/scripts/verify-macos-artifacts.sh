#!/bin/sh
set -eu

if [ "${1-}" = "--" ]; then
  shift
fi

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 /path/to/Orchestrat.app [/path/to/Orchestrat.dmg]" >&2
  exit 64
fi

app_path=$1
dmg_path=${2-}

if [ ! -d "$app_path" ]; then
  echo "app bundle does not exist: $app_path" >&2
  exit 1
fi

for command_name in codesign spctl xcrun; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required macOS tool is unavailable: $command_name" >&2
    exit 1
  fi
done

codesign --verify --deep --strict --verbose=2 "$app_path"
spctl --assess --type execute --verbose=2 "$app_path"
xcrun stapler validate "$app_path"

if [ -n "$dmg_path" ]; then
  if [ ! -f "$dmg_path" ]; then
    echo "disk image does not exist: $dmg_path" >&2
    exit 1
  fi

  hdiutil imageinfo "$dmg_path" >/dev/null
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg_path"
  xcrun stapler validate "$dmg_path"
fi
