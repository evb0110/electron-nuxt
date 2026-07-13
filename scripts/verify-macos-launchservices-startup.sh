#!/bin/bash
set -euo pipefail

source "$(dirname "$0")/release/platform-arch.sh"

if [ "$#" -ne 2 ]; then
  release_target_usage "$0"
  exit 1
fi

platform="$1"
arch="$2"
resolve_release_target_platform_arch "$platform" "$arch" >/dev/null
detect_release_host_platform

if [ "$platform" != "mac" ] || [ "$RELEASE_HOST_PLATFORM" != "mac" ]; then
  echo "Error: LaunchServices startup verification requires a mac target on a mac host"
  exit 1
fi

app_path="${EVB_LAUNCHSERVICES_APP_PATH:-release/mac-$arch/EVB Viewer.app}"
if [ ! -d "$app_path" ]; then
  echo "Error: Could not find packaged app bundle: $app_path"
  exit 1
fi
app_path="$(cd "$(dirname "$app_path")" && pwd -P)/$(basename "$app_path")"

app_exec="$app_path/Contents/MacOS/EVB Viewer"
if [ ! -x "$app_exec" ]; then
  echo "Error: Packaged app executable is missing or not executable: $app_exec"
  exit 1
fi

token="evb-launchservices-smoke-$$-$(date +%s)"
user_data_dir="$(mktemp -d "${TMPDIR:-/tmp}/evb-launchservices-smoke.XXXXXX")"
log_dir="$user_data_dir/electron-logs"
main_log="$log_dir/main.log"
window_log="$log_dir/window.log"
open_pid=""
app_pid=""

cleanup() {
  if [ -n "$app_pid" ] && kill -0 "$app_pid" >/dev/null 2>&1; then
    kill "$app_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$open_pid" ] && kill -0 "$open_pid" >/dev/null 2>&1; then
    kill "$open_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$user_data_dir"
}
trap cleanup EXIT

mkdir -p "$log_dir"

# -a receives the exact bundle path, -n forces a separate instance, and the
# unique Chromium user-data directory prevents the canary from attaching to or
# mutating an installed production instance.
env -u ELECTRON_RUN_AS_NODE open -n -W -a "$app_path" \
  --env "EVB_FILE_LOG_DIR=$log_dir" \
  --env "EVB_AUTOMATION_USER_DATA_DIR=$user_data_dir" \
  --env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1" \
  --args \
  --evb-startup-trace \
  --evb-launchservices-smoke="$token" \
  --user-data-dir="$user_data_dir" &
open_pid=$!

timeout_secs=60
deadline=$((SECONDS + timeout_secs))
while [ "$SECONDS" -lt "$deadline" ]; do
  app_pid="$(ps -axo pid=,command= | awk -v executable="$app_exec" -v token="$token" '
    !found && index($0, executable) && index($0, token) { pid = $1; found = 1 }
    END { if (found) print pid }
  ')"
  if [ -n "$app_pid" ]; then
    break
  fi
  if ! kill -0 "$open_pid" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ -z "$app_pid" ]; then
  echo "Error: LaunchServices did not start the requested packaged bundle"
  exit 1
fi

ready_marker="$(pnpm exec tsx scripts/release/printPackagedStartupReadyMarker.ts)"
ready=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -f "$main_log" ] && grep -F -q "$ready_marker" "$main_log" && kill -0 "$app_pid" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$app_pid" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ "$ready" -ne 1 ]; then
  echo "Error: Packaged app failed LaunchServices startup verification"
  echo "--- main.log ---"
  cat "$main_log" 2>/dev/null || true
  echo "--- window.log ---"
  cat "$window_log" 2>/dev/null || true
  exit 1
fi

echo "LaunchServices startup verification passed for $platform-$arch using $app_path"
