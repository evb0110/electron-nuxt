import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const projectRoot = process.cwd();

async function workflow(name: string) {
    return readFile(path.join(projectRoot, '.github/workflows', name), 'utf8');
}

function expectInOrder(source: string, markers: string[]) {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker, previous + 1);
        expect(index, `Missing or out-of-order workflow marker: ${marker}`).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('private Sentry source-map workflow policy', () => {
    it.each([
        [
            'build-target.yml',
            'Verify release artifacts',
            'Upload artifacts',
        ],
        [
            'build-mac-intel.yml',
            'Verify packaged macOS Intel core PDF journey',
            'Upload artifacts',
        ],
        [
            'store-appx.yml',
            'Record Microsoft Store packaged-app provenance',
            'Upload Microsoft Store AppX',
        ],
    ])('uploads private maps after package proof and before public artifacts in %s', async (
        file,
        proofStep,
        artifactStep,
    ) => {
        const source = await workflow(file);
        expectInOrder(source, [
            `- name: ${proofStep}`,
            '- name: Check private Sentry upload readiness',
            '- name: Upload private Sentry source maps',
            'run: node scripts/release/upload-sentry-sourcemaps.mjs',
            '- name: Send private Sentry source-map canaries',
            'run: node scripts/release/send-sentry-sourcemap-canaries.mjs',
            '- name: Verify private Sentry source-map canaries',
            'run: node scripts/release/verify-sentry-sourcemap-canaries.mjs',
            '- name: Upload Sentry source-map verification receipt',
            `- name: ${artifactStep}`,
        ]);
        expect(source).toContain('steps.sentry_upload.outputs.enabled == \'true\'');
        expect(source).toContain('inputs.send_sentry_canaries');
        expect(source).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
        expect(source).toContain('SENTRY_VERIFICATION_TOKEN: ${{ secrets.SENTRY_VERIFICATION_TOKEN }}');
        expect(source).toContain('SENTRY_VERIFICATION_CONFIGURED: ${{ secrets.SENTRY_VERIFICATION_TOKEN != \'\' }}');
        expect(source).toContain('[ "$SENTRY_VERIFICATION_CONFIGURED" != \'true\' ]');
        expect(source).toContain('SENTRY_DESKTOP_PROJECT: ${{ secrets.SENTRY_DESKTOP_PROJECT }}');
        expect(source).toContain('SENTRY_ORG: ${{ secrets.SENTRY_ORG }}');
        expect(source).toContain('canary-verification-receipt.json');
    });

    it('disables every lane when all credentials are absent and rejects partial configuration', async () => {
        for (const name of [
            'build-target.yml',
            'build-mac-intel.yml',
            'store-appx.yml',
        ]) {
            const source = await workflow(name);
            expect(source).toContain('elif [ "$configured" -eq 0 ]; then');
            expect(source).toContain('Sentry diagnostics credentials are partially configured.');
            expect(source).not.toContain('[ "$EVB_SENTRY_ENVIRONMENT" != \'production\' ]');
            expect(source).toContain('SENTRY_DESKTOP_DSN: ${{ secrets.SENTRY_DESKTOP_DSN }}');
        }
        expect(await workflow('build-target.yml')).toContain('if: ${{ inputs.upload_artifacts }}');
    });

    it('keeps the Windows 7 lane advisory and credential-free', async () => {
        const source = await workflow('build-win7-legacy.yml');
        expect(source).toContain('continue-on-error: true');
        expect(source).toContain('name: Record artifact status');
        expect(source).not.toContain('SENTRY_');
        expect(source).not.toContain('sentry_environment');
        expect(source).not.toContain('send_sentry_canaries');
        expect(source).not.toContain('Resolve Sentry build identity');

        const releaseWorkflow = await workflow('release-artifacts.yml');
        const win7Start = releaseWorkflow.indexOf('  build_win7_legacy:');
        const storeStart = releaseWorkflow.indexOf('  build_store:', win7Start);
        expect(win7Start).toBeGreaterThanOrEqual(0);
        expect(storeStart).toBeGreaterThan(win7Start);
        const win7Section = releaseWorkflow.slice(win7Start, storeStart);
        expect(win7Section).toContain('uses: ./.github/workflows/build-win7-legacy.yml');
        expect(win7Section).not.toContain('SENTRY_');
        expect(win7Section).not.toContain('sentry_environment');
        expect(win7Section).not.toContain('send_sentry_canaries');
    });

    it('does not upload on supplemental re-dispatch paths that reuse attached assets', async () => {
        const source = await workflow('release-supplemental.yml');

        expect(source).not.toContain('upload-sentry-sourcemaps.mjs');
        expect(source).toContain('needs.resolve.outputs.existing_win_arm64 != \'true\'');
        expect(source).toContain('needs.resolve.outputs.existing_mac_x64 != \'true\'');
        expect(source).toContain('needs.resolve.outputs.existing_win_arm64 == \'true\'');
        expect(source).toContain('needs.resolve.outputs.existing_mac_x64 == \'true\'');
    });

    it('passes the private build and upload values through every reusable desktop lane', async () => {
        const sources = await Promise.all([
            workflow('build.yml'),
            workflow('release.yml'),
            workflow('release-artifacts.yml'),
            workflow('release-supplemental.yml'),
        ]);
        for (const source of sources) {
            expect(source).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
            expect(source).toContain('SENTRY_VERIFICATION_TOKEN: ${{ secrets.SENTRY_VERIFICATION_TOKEN }}');
            expect(source).toContain('SENTRY_DESKTOP_PROJECT: ${{ secrets.SENTRY_DESKTOP_PROJECT }}');
            expect(source).toContain('SENTRY_DESKTOP_DSN: ${{ secrets.SENTRY_DESKTOP_DSN }}');
            expect(source).toContain('SENTRY_ORG: ${{ secrets.SENTRY_ORG }}');
        }
    });
});
