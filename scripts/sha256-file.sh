#!/bin/bash

sha256_file() {
  local path="$1"

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return
  fi

  if command -v certutil >/dev/null 2>&1; then
    certutil -hashfile "$path" SHA256 \
      | awk 'tolower($0) ~ /^[[:xdigit:]][[:xdigit:] ]+[[:xdigit:]]$/ { gsub(/[[:space:]]/, ""); print tolower($0); exit }'
    return
  fi

  echo "Error: No SHA256 tool found; expected shasum, sha256sum, or certutil" >&2
  return 127
}
