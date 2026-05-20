#!/bin/bash
set -euo pipefail

if [ -z "${GITHUB_ENV:-}" ]; then
  echo "Error: GITHUB_ENV must be set"
  exit 1
fi

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "Error: RUNNER_TEMP must be set"
  exit 1
fi

echo "MAC_CSC_LINK=" >> "$GITHUB_ENV"
echo "MAC_CSC_KEY_PASSWORD=" >> "$GITHUB_ENV"
echo "MAC_EXPECT_DEVELOPER_ID=false" >> "$GITHUB_ENV"
echo "APPLE_API_KEY_PATH=" >> "$GITHUB_ENV"
echo "APPLE_API_KEY_ID_ENV=" >> "$GITHUB_ENV"
echo "APPLE_API_ISSUER_ENV=" >> "$GITHUB_ENV"

if [ -n "${CSC_LINK:-}" ] && [ -n "${CSC_KEY_PASSWORD:-}" ]; then
  echo "MAC_CSC_LINK=$CSC_LINK" >> "$GITHUB_ENV"
  echo "MAC_CSC_KEY_PASSWORD=$CSC_KEY_PASSWORD" >> "$GITHUB_ENV"
  echo "MAC_EXPECT_DEVELOPER_ID=true" >> "$GITHUB_ENV"
elif [ -n "${CSC_LINK:-}" ] || [ -n "${CSC_KEY_PASSWORD:-}" ]; then
  echo "::warning::Partial macOS signing credentials detected; building unsigned ad-hoc app"
else
  echo "::notice::No macOS signing certificate configured; building unsigned ad-hoc app"
fi

if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  api_key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
  printf '%s' "$APPLE_API_KEY" > "$api_key_path"
  chmod 600 "$api_key_path"
  echo "APPLE_API_KEY_PATH=$api_key_path" >> "$GITHUB_ENV"
  echo "APPLE_API_KEY_ID_ENV=$APPLE_API_KEY_ID" >> "$GITHUB_ENV"
  echo "APPLE_API_ISSUER_ENV=$APPLE_API_ISSUER" >> "$GITHUB_ENV"
elif [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_API_KEY_ID:-}" ] || [ -n "${APPLE_API_ISSUER:-}" ]; then
  echo "::warning::Partial APPLE_API_* secrets detected; notarization disabled"
fi
