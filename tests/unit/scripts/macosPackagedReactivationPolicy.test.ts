import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('macOS packaged-reactivation diagnostic policy', () => {
    it('isolates and identifies the exact packaged canary before terminating it', async () => {
        const script = await readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8');

        expect(script).toContain('app_path="${EVB_REACTIVATION_APP_PATH:-release/mac-$arch/EVB Viewer.app}"');
        expect(script).toContain('open -n -a "$app_path"');
        expect(script).toContain('--user-data-dir="$user_data_dir"');
        expect(script).toContain('EVB_REACTIVATION_APP_PATH:-release/mac-$arch/EVB Viewer.app');
        expect(script).toContain('xcrun swiftc scripts/macos-app-lifecycle-probe.swift');
        expect(script).toContain('--env "EVB_AUTOMATION_USER_DATA_DIR=$user_data_dir"');
        expect(script).toContain('--env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1"');
        expect(script).toContain('--evb-launchservices-smoke="$token"');
        expect(script).toContain('activate_canary\nassert_frontmost_visible_window "cold packaged startup and exact-path activation"');
        expect(script).toContain('"$probe" ready "$app_pid"');
        expect(script).toContain('artifact_dir="$(cd "$artifact_dir" && pwd -P)"');
        expect(script).toContain('index($0, executable) && index($0, token)');
        expect(script).toContain('if is_tokenized_canary; then');
        expect(script).not.toMatch(/\/Applications\/EVB Viewer\.app/u);
        expect(script).not.toMatch(/\bkillall\b|\bpkill\b/u);
    });

    it('requires Accessibility and exercises the foreground recovery matrix', async () => {
        const script = await readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8');

        expect(script).toContain('get UI elements enabled');
        expect(script).toContain('for cycle in $(seq 1 20)');
        expect(script).toContain('"$probe" not-frontmost "$app_pid"');
        expect(script).toContain('"$probe" not-visible "$app_pid"');
        expect(script).toContain('"$probe" no-window "$app_pid"');
        expect(script).toContain('"$probe" minimize "$app_pid"');
        expect(script).toContain('"$probe" hide "$app_pid"');
        expect(script).toContain('"$probe" close "$app_pid"');
        expect(script).toContain('set_canary_minimized');
        expect(script).toContain('hide_canary');
        expect(script).toContain('close_last_canary_window');
        expect(script).toContain('open -a "$app_path"');
    });

    it('retains isolated logs and requires the packaged-ready marker', async () => {
        const [
            script,
            releaseRunbook,
        ] = await Promise.all([
            readFile('scripts/verify-macos-packaged-reactivation.sh', 'utf8'),
            readFile('docs/releasing.md', 'utf8'),
        ]);

        expect(script).toContain('EVB_REACTIVATION_ARTIFACT_DIR');
        expect(script).toContain('EVB_FILE_LOG_DIR=$log_dir');
        expect(script).toContain('printPackagedStartupReadyMarker.ts');
        expect(script).toContain('grep -F -q "$marker" "$main_log"');
        expect(script).toContain('tail -n 200 "$main_log"');
        expect(script).toContain('tail -n 200 "$window_log"');
        expect(releaseRunbook).toContain('bash scripts/verify-macos-packaged-reactivation.sh mac <arm64|x64>');
        expect(releaseRunbook).toContain('does not claim to automate the 30-minute soak');
    });
});
