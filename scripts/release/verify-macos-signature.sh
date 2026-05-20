#!/bin/bash
set -euo pipefail

release_dir="${1:-release}"
app_path="$(find "$release_dir" -maxdepth 3 -type d -name '*.app' | head -n 1)"

if [ -z "$app_path" ]; then
  echo "::error::No .app bundle found in $release_dir/"
  exit 1
fi

sign_info="$(codesign -dv --verbose=4 "$app_path" 2>&1 || true)"
echo "$sign_info"

if ! codesign --verify --deep --strict --verbose=2 "$app_path"; then
  echo "::error::App bundle signature is invalid"
  exit 1
fi

if [ "${MAC_EXPECT_DEVELOPER_ID:-false}" = "true" ] && echo "$sign_info" | grep -q "TeamIdentifier=not set"; then
  echo "::error::App bundle is not signed with a Developer ID certificate"
  exit 1
fi

if [ "${MAC_EXPECT_DEVELOPER_ID:-false}" = "true" ] && ! spctl --assess --type execute --verbose=4 "$app_path"; then
  echo "::error::App bundle is not accepted by macOS Gatekeeper"
  exit 1
fi
