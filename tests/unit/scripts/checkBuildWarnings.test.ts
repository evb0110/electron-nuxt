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
            '[warn] "file:///D:/a/evb-viewer/evb-viewer/node_modules/.pnpm/@nuxt+nitro-server@4.4.2_hash/node_modules/@nuxt/nitro-server/dist/runtime/utils/cache-driver.js" is imported by "\u0000virtual:#nitro-internal-virtual/storage", but could not be resolved \u2013 treating it as an external dependency.',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows the same cache-driver warning when Nitro emits an mjs path', async () => {
        const result = await runWarningCheck([
            '[warn] "file:///D:/a/evb-viewer/evb-viewer/node_modules/.pnpm/@nuxt+nitro-server@4.5.2_hash/node_modules/@nuxt/nitro-server/dist/runtime/utils/cache-driver.mjs" is imported by "virtual:#nitro-internal-virtual/storage", but could not be resolved \u2013 treating it as an external dependency.',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('keeps Nuxt build log records out of one-line warning blocks', async () => {
        const result = await runWarningCheck([
            '[warn] "file:///D:/a/evb-viewer/evb-viewer/node_modules/.pnpm/@nuxt+nitro-server@4.4.2_820334768e79cbb19f979b888702c608/node_modules/@nuxt/nitro-server/dist/runtime/utils/cache-driver.js" is imported by "virtual:#nitro-internal-virtual/storage", but could not be resolved \u2013 treating it as an external dependency.',
            '[info] [nitro] Prerendering 6 routes',
            '[log] [nitro]   /workspace (11ms)',
            '[success] [nitro] Generated public nuxt-output/public',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows transient Nuxt Fonts Fontshare retry warnings', async () => {
        const result = await runWarningCheck([
            '[warn] Could not fetch from `https://api.fontshare.com/v2/fonts`. Will retry in `1000ms`. `3` retries left.',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows known Rollup warnings even when the build output colorizes paths', async () => {
        const result = await runWarningCheck([
            'WARN \u001B[33mnode_modules/.pnpm/@vueuse+core@14.3.0_vue@3.5.33_typescript@5.9.3_/node_modules/@vueuse/core/dist/index.js (3362:0): A comment',
            '"/* #__PURE__ */"',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows bounded Rolldown plugin timing diagnostics', async () => {
        const result = await runWarningCheck([
            '[warn] \u001B[33m\u001B[33m[PLUGIN_TIMINGS] \u001B[0mYour build spent 96% of 13.2s inside plugin hooks (12.6s).',
            'Measured inside the callback, so queue time is excluded:',
            '  - @tailwindcss/vite:generate:build transform (13%, 1.7s, 102 calls)',
            'See https://rolldown.rs/reference/InputOptions.checks#plugintimings for more details.',
            '\u001B[39m',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows the known Nuxt Nitro unused H3 type imports', async () => {
        const result = await runWarningCheck([
            'WARN "H3Error" and "H3Event" are imported from external module "file:///home/runner/work/evb-viewer/evb-viewer/node_modules/.pnpm/h3@1.15.11/node_modules/h3/dist/index.mjs" but never used in "node_modules/.pnpm/@nuxt+nitro-server@4.5.1_hash/node_modules/@nuxt/nitro-server/dist/h3.mjs".',
            '[nitro] ℹ Prerendering 7 routes',
            '[nitro]   ├─ /workspace (20ms)',
            '[nitro] ✔ Generated public nuxt-output/public',
            '',
        ].join('\n'));

        expect(result.stdout).toContain('Build warning check passed: 1 known warning(s).');
    });

    it('allows the known Nuxt Nitro unused H3 imports with a Windows drive URL', async () => {
        const result = await runWarningCheck([
            'WARN "H3Error" and "H3Event" are imported from external module "file://D:/a/evb-viewer/evb-viewer/node_modules/.pnpm/h3@1.15.11/node_modules/h3/dist/index.mjs" but never used in "node_modules/.pnpm/@nuxt+nitro-server@4.5.2_hash/node_modules/@nuxt/nitro-server/dist/h3.mjs".',
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

    it('rejects unexpected continuation lines in otherwise allowlisted warning blocks', async () => {
        await expect(runWarningCheck([
            '[warn] Could not fetch from `https://api.fontshare.com/v2/fonts`. Will retry in `1000ms`. `3` retries left.',
            'unexpected retry detail from production build',
            '',
        ].join('\n'))).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('unexpected retry detail from production build'),
        });
    });
});
