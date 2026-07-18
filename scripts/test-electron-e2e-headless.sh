#!/bin/bash
set -euo pipefail

platform="$(uname -s)"

export EVB_AUTOMATION_DISABLE_SANDBOX=1
export EVB_AUTOMATION_NO_FOCUS=1

if [ "$platform" = "Linux" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "xvfb-run is required for headless Linux Electron E2E. Run bash scripts/setup-linux-dev-host.sh." >&2
    exit 1
  fi
  export EVB_AUTOMATION_HIDE_WINDOW=0
  exec xvfb-run -a pnpm run test:e2e:electron
fi

export EVB_AUTOMATION_HIDE_WINDOW=1
if [ "$platform" = "Darwin" ]; then
  export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1
fi

exec pnpm run test:e2e:electron
