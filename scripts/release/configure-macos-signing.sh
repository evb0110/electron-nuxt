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

fail_or_warn_partial_credentials() {
  local message="$1"
  if [ "${CI:-}" = "true" ]; then
    echo "::error::$message"
    exit 1
  fi

  echo "::warning::$message"
}

if [ -n "${CSC_LINK:-}" ] && [ -n "${CSC_KEY_PASSWORD:-}" ]; then
  echo "MAC_CSC_LINK=$CSC_LINK" >> "$GITHUB_ENV"
  echo "MAC_CSC_KEY_PASSWORD=$CSC_KEY_PASSWORD" >> "$GITHUB_ENV"
  echo "MAC_EXPECT_DEVELOPER_ID=true" >> "$GITHUB_ENV"
elif [ -n "${CSC_LINK:-}" ] || [ -n "${CSC_KEY_PASSWORD:-}" ]; then
  fail_or_warn_partial_credentials "Partial macOS signing credentials detected; set both CSC_LINK and CSC_KEY_PASSWORD or neither"
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
  fail_or_warn_partial_credentials "Partial APPLE_API_* secrets detected; set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER or none of them"
fi
