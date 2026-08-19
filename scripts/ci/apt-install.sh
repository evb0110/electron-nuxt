#!/usr/bin/env bash
# Installs apt packages on a GitHub runner without letting a stalled mirror
# hold the job for its whole timeout budget. A flaky Azure mirror has hung
# `apt-get update` for 27 minutes inside a 30-minute job; per-request
# timeouts turn that into a fast failure and the retry loop gives a
# transient outage a few chances to clear.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <package>..." >&2
    exit 2
fi

apt_opts=(
    -o Acquire::Retries=3
    -o Acquire::http::Timeout=30
    -o Acquire::https::Timeout=30
    -o Acquire::ForceIPv4=true
    -o DPkg::Lock::Timeout=120
)

for attempt in 1 2 3; do
    if sudo apt-get "${apt_opts[@]}" update \
        && sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_opts[@]}" install -y --no-install-recommends "$@"; then
        exit 0
    fi
    echo "apt install attempt ${attempt} failed; retrying" >&2
    sleep $((attempt * 15))
done

echo "apt install failed after 3 attempts: $*" >&2
exit 1
