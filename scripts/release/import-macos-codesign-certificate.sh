#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping macOS certificate import on non-macOS host."
  exit 0
fi

if [ -z "${CSC_LINK:-}" ] || [ -z "${CSC_KEY_PASSWORD:-}" ]; then
  echo "Skipping macOS certificate import; CSC_LINK/CSC_KEY_PASSWORD are not both set."
  exit 0
fi

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "Error: RUNNER_TEMP must be set"
  exit 1
fi

decode_base64() {
  local value="$1"
  local output_path="$2"

  if printf '' | base64 --decode >/dev/null 2>&1; then
    printf '%s' "$value" | base64 --decode > "$output_path"
  else
    printf '%s' "$value" | base64 -D > "$output_path"
  fi
}

certificate_path="$RUNNER_TEMP/evb-codesign-cert.p12"
case "$CSC_LINK" in
  file://*)
    certificate_path="${CSC_LINK#file://}"
    ;;
  http://*|https://*)
    curl --fail --silent --show-error --location "$CSC_LINK" --output "$certificate_path"
    ;;
  base64://*)
    decode_base64 "${CSC_LINK#base64://}" "$certificate_path"
    ;;
  data:*base64,*)
    decode_base64 "${CSC_LINK#*,}" "$certificate_path"
    ;;
  *)
    if [ -f "$CSC_LINK" ]; then
      certificate_path="$CSC_LINK"
    else
      decode_base64 "$CSC_LINK" "$certificate_path"
    fi
    ;;
esac

if [ ! -s "$certificate_path" ]; then
  echo "Error: macOS signing certificate payload is empty"
  exit 1
fi

keychain_path="$RUNNER_TEMP/evb-dmg-codesign.keychain-db"
keychain_password="$(uuidgen)-$(uuidgen)"
rm -f "$keychain_path"

security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$certificate_path" \
  -k "$keychain_path" \
  -P "$CSC_KEY_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"

existing_keychains=()
while IFS= read -r existing_keychain; do
  existing_keychain="${existing_keychain#"${existing_keychain%%[![:space:]]*}"}"
  existing_keychain="${existing_keychain%\"}"
  existing_keychain="${existing_keychain#\"}"
  if [ -n "$existing_keychain" ] && [ "$existing_keychain" != "$keychain_path" ]; then
    existing_keychains+=("$existing_keychain")
  fi
done < <(security list-keychains -d user)

security list-keychains -d user -s "$keychain_path" "${existing_keychains[@]}"
security default-keychain -d user -s "$keychain_path"

identity_count="$(security find-identity -v -p codesigning "$keychain_path" | grep -c 'Developer ID Application' || true)"
if [ "$identity_count" = "0" ]; then
  echo "Error: imported certificate did not expose a Developer ID Application identity"
  exit 1
fi

echo "Imported macOS Developer ID certificate for direct codesign use."
