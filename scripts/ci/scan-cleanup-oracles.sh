#!/bin/sh

set -eu

mode=${1:-}
output_root=${2:-.devkit/scratch/scan-cleanup-oracles}

run_catastrophe_oracle() {
  cargo run --manifest-path native/Cargo.toml --locked --release \
    --package evb-scan-cleanup --bin scan-cleanup-harness -- \
    --baseline native/scan-cleanup/harness-baseline.json \
    --out "$output_root/native"
}

build_scan_cleanup_tool() {
  pnpm run build:scan-cleanup
}

# Asks the same resolver the export oracles use, so this check cannot disagree
# with what they need on disk. Exit 20 is the resolver answering "nothing there";
# any other failure means the probe itself could not run, and reporting that as a
# missing binary would send an otherwise healthy push into a Rust build and a wait
# on the machine-wide heavy gate before failing for the real reason anyway.
scan_cleanup_tool_is_available() {
  probe_status=0
  probe_error=$(node --input-type=module -e '
import {pathToFileURL} from "node:url";
import {tsImport} from "tsx/esm/api";
const root = pathToFileURL(`${process.cwd()}/`).href;
const {resolveCliNativeToolPath} = await tsImport("./scripts/scanCleanupCliAdapters.ts", root);
process.exit(resolveCliNativeToolPath("evb-scan-cleanup", "scan-cleanup", process.cwd(), process.env.EVB_SCAN_CLEANUP_PATH) ? 0 : 20);
' 2>&1 >/dev/null) || probe_status=$?
  case "$probe_status" in
    0) return 0 ;;
    20) return 1 ;;
  esac
  printf '%s\n' "error: cannot tell whether the scan-cleanup tool is present (probe exited $probe_status)" >&2
  if [ -n "$probe_error" ]; then
    printf '%s\n' "$probe_error" >&2
  fi
  exit 1
}

run_stroke_weight_oracle() {
  stroke_output="$output_root/stroke-weight"
  mkdir -p "$stroke_output"
  mkdir -p .devkit/tmp/stroke-weight-oracle
  node --test scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.test.mjs
  native/target/release/evb-scan-cleanup \
    --manifest scripts/diagnostics/stroke-weight-oracle/calibration/render-manifest.json
  node scripts/diagnostics/stroke-weight-oracle/stroke-weight-oracle.mjs \
    --image .devkit/tmp/stroke-weight-oracle/diyarbakir-clean.png \
    --image .devkit/tmp/stroke-weight-oracle/wahrscheinlich-clean.png \
    --image .devkit/tmp/stroke-weight-oracle/handschrift-clean.png \
    --dpi 300 \
    --out "$stroke_output/report.json"
  node scripts/diagnostics/stroke-weight-oracle/assert-calibration.mjs \
    --report "$stroke_output/report.json" \
    --reference scripts/diagnostics/stroke-weight-oracle/calibration/s5-line-stroke-budget-green.json
}

supports_type_stripping() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);
  '
}

run_export_oracles() {
  node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
    --source tests/fixtures/electron/test-scanned.pdf \
    --pages 1 \
    --out "$output_root/preview" \
    --check

  node scripts/diagnostics/scan-cleanup-word-loss-audit.mjs \
    --source tests/fixtures/electron/test-scanned.pdf \
    --cleaned "$output_root/preview/final-reference.pdf" \
    --mapping "$output_root/preview/final-reference.pdf.summary.json" \
    --from 1 \
    --to 1 \
    --out "$output_root/word-loss.json" \
    --fail-on text-loss
}

native_or_build_changed() {
  remote_name=$1
  upstream_ref=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  if [ -z "$upstream_ref" ]; then
    upstream_ref="$remote_name/main"
  fi
  if ! git rev-parse --verify "$upstream_ref^{commit}" >/dev/null 2>&1; then
    printf '%s\n' "warning: cannot resolve upstream ref $upstream_ref; running native scan-cleanup oracles conservatively" >&2
    return 0
  fi

  classifier_output=$(mktemp "${TMPDIR:-/tmp}/evb-scan-cleanup-classifier.XXXXXX")
  trap 'rm -f "$classifier_output"' EXIT HUP INT TERM
  if ! GITHUB_OUTPUT="$classifier_output" node scripts/ci/classify-changed-areas.mjs \
    --base="$upstream_ref" --head=HEAD >/dev/null; then
    printf '%s\n' 'warning: changed-area classification failed; running native scan-cleanup oracles conservatively' >&2
    return 0
  fi
  grep -qx 'native_or_build=true' "$classifier_output"
}

case "$mode" in
  native)
    run_catastrophe_oracle
    ;;
  export)
    if ! supports_type_stripping; then
      printf '%s\n' 'scan-cleanup export oracles require Node >= 22.18 for TypeScript stripping.' >&2
      exit 1
    fi
    build_scan_cleanup_tool
    run_stroke_weight_oracle
    run_export_oracles
    ;;
  pre-push)
    remote_name=${3:-origin}
    native_changed=0
    if native_or_build_changed "$remote_name"; then
      native_changed=1
      run_catastrophe_oracle
    fi
    if ! supports_type_stripping; then
      node_version=$(node --version 2>/dev/null || printf 'unavailable')
      printf '%s\n' \
        "warning: skipping scan-cleanup preview and word-loss pre-push oracles; Node >= 22.18 is required (found $node_version)" >&2
      exit 0
    fi
    # The export oracles drive the built tool on every push, so the tool has to be
    # present whether or not native sources changed -- gating the build on changed
    # sources left a fresh checkout unable to push at all. Building is also what
    # takes the machine-wide heavy gate and needs a Rust toolchain, so only reach
    # for it when sources moved or the binary is genuinely missing; an ordinary
    # push then waits on no gate capacity and needs no cargo on PATH.
    if [ "$native_changed" -eq 1 ]; then
      build_scan_cleanup_tool
      run_stroke_weight_oracle
    elif ! scan_cleanup_tool_is_available; then
      build_scan_cleanup_tool
    fi
    run_export_oracles
    ;;
  *)
    printf '%s\n' 'usage: scripts/ci/scan-cleanup-oracles.sh <native|export|pre-push> [output-root] [remote]' >&2
    exit 2
    ;;
esac
