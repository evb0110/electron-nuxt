#!/bin/bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <attempts> <delay-seconds> <label> <command> [args...]"
  exit 1
fi

attempts="$1"
delay_seconds="$2"
label="$3"
shift 3

for attempt in $(seq 1 "$attempts"); do
  if "$@"; then
    exit 0
  fi

  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::${label} attempt $attempt failed, retrying in ${delay_seconds}s..."
    sleep "$delay_seconds"
  fi
done

echo "::error::${label} failed after $attempts attempts"
exit 1
