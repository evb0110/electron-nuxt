import { execFile } from 'node:child_process';
import {
    mkdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const execFileAsync = promisify(execFile);
const warningLogPath = '.tmp/check-build-warnings-test.log';

async function runWarningCheck(logText: string) {
    await mkdir('.tmp', { recursive: true });
    await writeFile(warningLogPath, logText, 'utf8');

    return execFileAsync('node', [
        'scripts/check-build-warnings.mjs',
        warningLogPath,
    ]);
}

describe('check-build-warnings', () => {
    afterEach(async () => {
        await rm(warningLogPath, { force: true });
    });

    it('allows Nuxt Nitro cache-driver externalization warnings from Windows file URLs', async () => {
        const result = await runWarningCheck([
            '[warn] "file:///D:/a/evb-viewer/evb-viewer/node_modules/.pnpm/@nuxt+nitro-server@4.4.2_hash/node_modules/@nuxt/nitro-server/dist/runtime/utils/cache-driver.js" is imported by "virtual:#nitro-internal-virtual/storage", but could not be resolved \u2013 treating it as an external dependency.',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('rejects unlisted warnings', async () => {
        await expect(runWarningCheck([
            '[warn] unexpected production build warning',
            '',
        ].join('\n'))).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('Unknown warnings found'),
        });
    });
});
