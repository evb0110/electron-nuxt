#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SESSION_ROOT="$PROJECT_ROOT/.devkit/sessions"
XVFB_ROOT="$PROJECT_ROOT/.devkit/headless-xvfb"
SCREEN_SPEC="${EVB_XVFB_SCREEN:-1440x1000x24}"

if [ "${1:-}" = "--" ]; then
  shift
fi

platform="$(uname -s)"

if [ "$platform" != "Linux" ]; then
  export EVB_AUTOMATION_NO_FOCUS=1
  export EVB_AUTOMATION_HIDE_WINDOW=1
  if [ "$platform" = "Darwin" ]; then
    export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1
  fi
  exec pnpm electron:run "$@"
fi

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "Xvfb is required for headless Linux Electron runs. Run bash scripts/setup-linux-dev-host.sh." >&2
  exit 1
fi

export EVB_AUTOMATION_DISABLE_SANDBOX="${EVB_AUTOMATION_DISABLE_SANDBOX:-1}"
export EVB_AUTOMATION_HIDE_WINDOW="${EVB_AUTOMATION_HIDE_WINDOW:-0}"

session_name="default"
stop_all=0
command=""
args=("$@")

for ((index = 0; index < ${#args[@]}; index += 1)); do
  arg="${args[$index]}"
  case "$arg" in
    --session=*)
      session_name="${arg#--session=}"
      ;;
    --session|-s)
      index=$((index + 1))
      session_name="${args[$index]:-default}"
      ;;
    --all)
      stop_all=1
      ;;
    -*)
      ;;
    *)
      if [ -z "$command" ]; then
        command="$arg"
      fi
      ;;
  esac
done

if [[ ! "$session_name" =~ ^[A-Za-z0-9_.-]+$ ]] || [[ "$session_name" == *..* ]]; then
  echo "Invalid session name: $session_name" >&2
  exit 1
fi

xvfb_dir="$XVFB_ROOT/$session_name"
pid_file="$xvfb_dir/xvfb.pid"
display_file="$xvfb_dir/xvfb-display"
log_file="$xvfb_dir/xvfb.log"
started_xvfb=0

is_pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

read_pid() {
  if [ -f "$pid_file" ]; then
    cat "$pid_file"
  fi
}

read_display() {
  if [ -f "$display_file" ]; then
    cat "$display_file"
  fi
}

find_free_display() {
  local number
  for number in $(seq 90 150); do
    if [ ! -e "/tmp/.X11-unix/X$number" ]; then
      echo ":$number"
      return 0
    fi
  done
  echo "No free Xvfb display found in :90..:150" >&2
  return 1
}

stop_xvfb_for_session() {
  local pid
  pid="$(read_pid || true)"
  if is_pid_alive "$pid"; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file" "$display_file"
}

stop_all_xvfb() {
  local file
  shopt -s nullglob
  for file in "$XVFB_ROOT"/*/xvfb.pid; do
    pid_file="$file"
    display_file="$(dirname "$file")/xvfb-display"
    stop_xvfb_for_session
  done
}

start_xvfb_for_session() {
  local existing_pid existing_display display
  mkdir -p "$xvfb_dir"

  existing_pid="$(read_pid || true)"
  existing_display="$(read_display || true)"
  if is_pid_alive "$existing_pid" && [ -n "$existing_display" ]; then
    export DISPLAY="$existing_display"
    return 0
  fi

  rm -f "$pid_file" "$display_file"
  display="$(find_free_display)"
  if command -v setsid >/dev/null 2>&1; then
    setsid Xvfb "$display" -screen 0 "$SCREEN_SPEC" -nolisten tcp >"$log_file" 2>&1 </dev/null &
  else
    nohup Xvfb "$display" -screen 0 "$SCREEN_SPEC" -nolisten tcp >"$log_file" 2>&1 </dev/null &
  fi
  echo "$!" > "$pid_file"
  echo "$display" > "$display_file"
  sleep 0.5

  if ! is_pid_alive "$(cat "$pid_file")"; then
    echo "Xvfb failed to start for display $display. See $log_file." >&2
    rm -f "$pid_file" "$display_file"
    exit 1
  fi

  started_xvfb=1
  export DISPLAY="$display"
}

command="${command:-}"

if [ "$command" = "stop" ]; then
  if [ "$stop_all" -eq 1 ]; then
    pnpm electron:run "$@"
    stop_all_xvfb
  else
    existing_display="$(read_display || true)"
    if [ -n "$existing_display" ]; then
      export DISPLAY="$existing_display"
    fi
    pnpm electron:run "$@"
    stop_xvfb_for_session
  fi
  exit 0
fi

case "$command" in
  ""|help|list|status)
    existing_display="$(read_display || true)"
    if [ -n "$existing_display" ]; then
      export DISPLAY="$existing_display"
    fi
    exec pnpm electron:run "$@"
    ;;
  *)
    start_xvfb_for_session
    ;;
esac

cleanup_on_exit() {
  local exit_code=$?
  if [ "$started_xvfb" -eq 1 ]; then
    stop_xvfb_for_session
  fi
  exit "$exit_code"
}

# A detached start runs in the background so an INT/TERM/HUP during the
# readiness wait reaches this shell and can undo the partial start: the
# runner is asked to stop the session, and an Xvfb started here is torn
# down. A successful start keeps Xvfb alive for the persistent session.
startd_pid=""

interrupted_startd() {
  local signal_name="$1" signal_number="$2"
  trap - INT TERM HUP
  echo "Headless $command for session '$session_name' interrupted by SIG$signal_name; stopping the session." >&2
  if is_pid_alive "$startd_pid"; then
    kill -TERM "$startd_pid" >/dev/null 2>&1 || true
    wait "$startd_pid" >/dev/null 2>&1 || true
  fi
  if ! pnpm electron:run --session="$session_name" stop; then
    echo "Session '$session_name' may still be running after the interrupted $command. Run: bash scripts/electron-run-headless.sh --session=$session_name stop" >&2
  fi
  if [ "$started_xvfb" -eq 1 ]; then
    stop_xvfb_for_session
  fi
  exit "$((128 + signal_number))"
}

case "$command" in
  startd|restartd)
    trap 'interrupted_startd INT 2' INT
    trap 'interrupted_startd TERM 15' TERM
    trap 'interrupted_startd HUP 1' HUP
    pnpm electron:run "$@" &
    startd_pid=$!
    if wait "$startd_pid"; then
      trap - INT TERM HUP
      exit 0
    fi
    trap - INT TERM HUP
    if [ "$started_xvfb" -eq 1 ]; then
      stop_xvfb_for_session
    fi
    exit 1
    ;;
  *)
    trap cleanup_on_exit EXIT
    pnpm electron:run "$@"
    ;;
esac
