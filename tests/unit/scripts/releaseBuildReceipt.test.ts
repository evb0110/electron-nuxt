import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertSentryPrivateManifestParity,
    computeReleaseBuildState,
    validateReleaseBuildReceipt,
    writeReleaseBuildReceipt,
} from '@scripts/release/build-receipt.mjs';
import {stagePrivateSourcemaps} from '@scripts/release/stage-private-sourcemaps.mjs';
import {createSentryBuildIdentity} from '@contracts/diagnostics/releaseIdentity.js';

function fakeToolchain(command: string, args: string[]) {
    return `${command} ${args.join(' ')} test-version`;
}

describe('release strict-build receipts', () => {
    it('accepts exact input/output reuse and rejects source, output, and toolchain changes', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-'));
        const inputPath = path.join(projectRoot, 'source.ts');
        const outputPath = path.join(projectRoot, 'dist', 'main.js');
        const receiptPath = path.join(projectRoot, '.devkit', 'receipt.json');
        mkdirSync(path.dirname(outputPath), {recursive: true});
        writeFileSync(inputPath, 'export const value = 1;\n');
        writeFileSync(outputPath, 'built-output\n');

        try {
            const options = {
                env: {NODE_ENV: 'production'},
                inputFiles: ['source.ts'],
                outputPaths: ['dist'],
                projectRoot,
                runCommand: fakeToolchain,
            };
            const original = writeReleaseBuildReceipt(receiptPath, options);
            expect(validateReleaseBuildReceipt(receiptPath, options)).toMatchObject({
                receipt: original,
                valid: true,
            });

            writeFileSync(inputPath, 'export const value = 2;\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
            writeFileSync(inputPath, 'export const value = 1;\n');
            writeFileSync(outputPath, 'tampered-output\n');
            expect(validateReleaseBuildReceipt(receiptPath, options)).toEqual({
                reason: 'outputs-changed',
                valid: false,
            });
            expect(validateReleaseBuildReceipt(receiptPath, {
                ...options,
                runCommand: (command: string, args: string[]) => (
                    `${command} ${args.join(' ')} different-version`
                ),
            })).toEqual({
                reason: 'inputs-changed',
                valid: false,
            });
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails closed when a required output is absent', () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-missing-'));
        writeFileSync(path.join(projectRoot, 'source.ts'), 'source\n');
        try {
            expect(() => computeReleaseBuildState({
                inputFiles: ['source.ts'],
                outputPaths: ['missing-output'],
                projectRoot,
                runCommand: fakeToolchain,
            })).toThrow();
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires injected bytes to match the private manifest before recording identity', async () => {
        const projectRoot = mkdtempSync(path.join(tmpdir(), 'evb-release-receipt-sentry-'));
        const packagePath = path.join(projectRoot, 'package.json');
        const inputPath = path.join(projectRoot, 'source.ts');
        const outputPath = path.join(projectRoot, 'dist-electron', 'main.js');
        mkdirSync(path.dirname(outputPath), {recursive: true});
        mkdirSync(path.join(projectRoot, 'electron'), {recursive: true});
        writeFileSync(packagePath, JSON.stringify({version: '1.2.3'}));
        writeFileSync(inputPath, 'export const value = 1;\n');
        writeFileSync(path.join(projectRoot, 'electron', 'main.ts'), 'export const value = 1;\n');
        writeFileSync(
            outputPath,
            'export const value=1;\n//# sourceMappingURL=main.js.map\n',
        );
        writeFileSync(`${outputPath}.map`, JSON.stringify({
            version: 3,
            file: 'main.js',
            sources: ['../electron/main.ts'],
            names: [],
            mappings: '',
        }));

        const desktopDsn = 'desktop-dsn-secret';
        const browserDsn = 'browser-dsn-secret';
        const nitroDsn = 'nitro-dsn-secret';
        const databaseUrl = 'database-url-secret';
        const options = {
            env: {
                NODE_ENV: 'production',
                EVB_RELEASE_TARGET_ARCH: 'arm64',
                EVB_RELEASE_TARGET_PLATFORM: 'mac',
                EVB_SENTRY_ENVIRONMENT: 'test',
                EVB_ELECTRON_SOURCEMAP: '1',
                SENTRY_DESKTOP_DSN: desktopDsn,
                NUXT_PUBLIC_SENTRY_DSN: browserDsn,
                NUXT_SENTRY_NITRO_DSN: nitroDsn,
                NUXT_ANALYTICS_DATABASE_URL: databaseUrl,
            },
            inputFiles: ['source.ts'],
            outputPaths: ['dist-electron'],
            projectRoot,
            runCommand: fakeToolchain,
        };

        try {
            const identity = createSentryBuildIdentity({
                target: 'desktop',
                version: '1.2.3',
                dist: 'macos-arm64',
                environment: 'test',
            });
            expect(() => assertSentryPrivateManifestParity({
                identity,
                projectRoot,
            })).toThrow();
            await stagePrivateSourcemaps({
                identity,
                outputRoots: ['dist-electron'],
                projectRoot,
                reset: true,
            });
            const state = computeReleaseBuildState(options);
            expect(state.contract.sentryIdentity).toEqual({
                target: 'desktop',
                release: 'evb-viewer-desktop@1.2.3',
                dist: 'macos-arm64',
                environment: 'test',
            });
            expect(state.contract.environment).not.toHaveProperty('SENTRY_DESKTOP_DSN');
            expect(state.contract.environment).not.toHaveProperty('NUXT_PUBLIC_SENTRY_DSN');
            expect(state.contract.environment).not.toHaveProperty('NUXT_SENTRY_NITRO_DSN');
            expect(state.contract.environment).not.toHaveProperty('NUXT_ANALYTICS_DATABASE_URL');
            expect(JSON.stringify(state.contract)).not.toContain(desktopDsn);
            expect(JSON.stringify(state.contract)).not.toContain(browserDsn);
            expect(JSON.stringify(state.contract)).not.toContain(nitroDsn);
            expect(JSON.stringify(state.contract)).not.toContain(databaseUrl);
            const beforeTamperHash = createHash('sha256').update(readFileSync(outputPath)).digest('hex');
            writeFileSync(outputPath, `${readFileSync(outputPath, 'utf8')}\n`);
            expect(() => computeReleaseBuildState(options)).toThrow(/does not match private manifest/iu);
            expect(beforeTamperHash).not.toBe(
                createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
            );
        } finally {
            rmSync(projectRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
