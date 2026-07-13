import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFile } from 'node:fs/promises';

describe('macOS LaunchServices packaged-startup policy', () => {
    it('targets only the exact packaged bundle and terminates only its tokenized process', async () => {
        const script = await readFile('scripts/verify-macos-launchservices-startup.sh', 'utf8');

        expect(script).toContain('open -n -W -a "$app_path"');
        expect(script).toContain('--user-data-dir="$user_data_dir"');
        expect(script).toContain('EVB_LAUNCHSERVICES_APP_PATH:-release/mac-$arch/EVB Viewer.app');
        expect(script).toContain('--env "EVB_AUTOMATION_USER_DATA_DIR=$user_data_dir"');
        expect(script).toContain('--env "EVB_ALLOW_MULTI_AUTOMATION_SESSIONS=1"');
        expect(script).toContain('--evb-launchservices-smoke="$token"');
        expect(script).toContain('log_dir="$user_data_dir/electron-logs"');
        expect(script).toContain('--env "EVB_FILE_LOG_DIR=$log_dir"');
        expect(script).not.toContain('rm -rf "$log_dir"');
        expect(script).toContain('index($0, executable) && index($0, token)');
        expect(script).toContain('grep -F -q "$ready_marker" "$main_log"');
        expect(script).not.toMatch(/\bkillall\b|\bpkill\b/u);
        expect(script).not.toContain('/Applications/EVB Viewer.app');
    });
});
