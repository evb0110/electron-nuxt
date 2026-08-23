#!/bin/bash
set -euo pipefail

platform="$(uname -s)"
if [ "${1:-}" = "--no-build" ]; then
  target_project="${2:-}"
  if [ -z "$target_project" ]; then
    echo "--no-build requires a Vitest project name." >&2
    exit 1
  fi
  target_id="$target_project-no-build"
  test_command=(pnpm exec vitest run --project "$target_project" --reporter verbose)
else
  target_script="${1:-test:e2e:electron}"
  target_id="$target_script"
  test_command=(pnpm run "$target_script")
fi

export EVB_AUTOMATION_DISABLE_SANDBOX=1
export EVB_AUTOMATION_NO_FOCUS=1

if [ "$platform" = "Linux" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "xvfb-run is required for headless Linux Electron E2E. Run bash scripts/setup-linux-dev-host.sh." >&2
    exit 1
  fi
  export EVB_AUTOMATION_HIDE_WINDOW=0
  exec node scripts/validation-gates.mjs heavy --id="electron-${target_id//:/-}" --weight=2 -- \
    xvfb-run -a "${test_command[@]}"
fi

export EVB_AUTOMATION_HIDE_WINDOW=1
if [ "$platform" = "Darwin" ]; then
  export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1
fi

exec node scripts/validation-gates.mjs heavy --id="electron-${target_id//:/-}" --weight=2 -- \
  "${test_command[@]}"
