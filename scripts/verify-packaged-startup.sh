#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <platform: mac|win|linux> <arch: x64|arm64>"
  exit 1
fi

platform="$1"
arch="$2"
release_dir="release"

host_platform=""
case "$(uname -s)" in
  Darwin)
    host_platform="mac"
    ;;
  Linux)
    host_platform="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    host_platform="win"
    ;;
  *)
    echo "Error: Unsupported host platform $(uname -s)"
    exit 1
    ;;
esac

if [ "$platform" != "$host_platform" ]; then
  echo "Skipping startup check for $platform-$arch on host $host_platform"
  exit 0
fi

# This verifier is intentionally mac-only today. Treat that as a current
# coverage gap, not as proof that Linux/Windows packaged startup is verified.
if [ "$platform" != "mac" ]; then
  echo "Error: Startup verification is currently implemented only for mac targets"
  exit 1
fi

app_path="$release_dir/mac-$arch/EVB Viewer.app"
if [ ! -d "$app_path" ]; then
  app_path=""
  while IFS= read -r candidate; do
    app_path="$candidate"
    break
  done < <(find "$release_dir" -maxdepth 4 -type d -name 'EVB Viewer.app' | sort)
fi

if [ -z "$app_path" ] || [ ! -d "$app_path" ]; then
  echo "Error: Could not find packaged app bundle in $release_dir/"
  exit 1
fi

default_port=3235
port="${EVB_SERVER_PORT:-$default_port}"
server_path="${EVB_SERVER_PATH:-/electron}"
case "$server_path" in
  /*)
    ;;
  *)
    server_path="/$server_path"
    ;;
esac
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
  if [ -n "${EVB_SERVER_PORT:-}" ]; then
    echo "Error: Requested TCP port $port is already in use"
    lsof -nP -iTCP:$port -sTCP:LISTEN || true
    exit 1
  fi

  port="$(node -e "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') process.exit(1); console.log(address.port); server.close(); });")"
  if [ -z "$port" ]; then
    echo "Error: Failed to allocate a free localhost port for startup verification"
    exit 1
  fi
  echo "TCP port $default_port is busy; using $port for packaged startup verification"
fi

log_dir="${TMPDIR:-/tmp}/electron-logs"
rm -rf "$log_dir"
mkdir -p "$log_dir"

app_exec="$app_path/Contents/MacOS/EVB Viewer"
app_pid=""
cleanup() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" >/dev/null 2>&1; then
    kill "$app_pid" >/dev/null 2>&1 || true
    sleep 1
  fi
}
trap cleanup EXIT

EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1 \
EVB_AUTOMATION_HIDE_WINDOW=1 \
EVB_AUTOMATION_NO_FOCUS=1 \
EVB_SERVER_PORT="$port" \
EVB_STARTUP_TRACE=1 \
"$app_exec" &
app_pid=$!

main_log="$log_dir/main.log"
server_log="$log_dir/server.log"
window_log="$log_dir/window.log"

timeout_secs=50
deadline=$((SECONDS + timeout_secs))
ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  renderer_ready=0
  if [ -f "$main_log" ] && grep -q 'Main renderer signaled ready' "$main_log"; then
    renderer_ready=1
  fi

  server_ready=0
  if [ -f "$server_log" ] && grep -q 'Server verified ready' "$server_log"; then
    server_ready=1
  elif curl -fsS --max-time 2 "http://127.0.0.1:$port$server_path" >/dev/null 2>&1; then
    server_ready=1
  fi

  if [ "$server_ready" -eq 1 ] && [ "$renderer_ready" -eq 1 ] && kill -0 "$app_pid" >/dev/null 2>&1; then
    ready=1
    break
  fi

  if ! kill -0 "$app_pid" >/dev/null 2>&1; then
    break
  fi

  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Error: Packaged app failed startup verification"
  echo "--- main.log ---"
  cat "$main_log" 2>/dev/null || true
  echo "--- server.log ---"
  cat "$server_log" 2>/dev/null || true
  echo "--- window.log ---"
  cat "$window_log" 2>/dev/null || true
  exit 1
fi

echo "Packaged startup verification passed for $platform-$arch"
