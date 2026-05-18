#!/bin/bash

sha256_file() {
  local path="$1"

  extract_sha256() {
    awk '{
      for (i = 1; i <= NF; i++) {
        token = tolower($i)
        gsub(/[^[:xdigit:]]/, "", token)
        if (length(token) == 64) {
          print token
          exit
        }
      }
    }'
  }

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | extract_sha256
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | extract_sha256
    return
  fi

  if command -v certutil >/dev/null 2>&1; then
    certutil -hashfile "$path" SHA256 | extract_sha256
    return
  fi

  echo "Error: No SHA256 tool found; expected shasum, sha256sum, or certutil" >&2
  return 127
}
