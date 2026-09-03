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
            'build-win7-legacy.yml',
            'Record artifact status',
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
            `- name: ${artifactStep}`,
        ]);
        expect(source).toContain('steps.sentry_upload.outputs.enabled == \'true\'');
        expect(source).toContain('SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}');
        expect(source).toContain('SENTRY_DESKTOP_PROJECT: ${{ secrets.SENTRY_DESKTOP_PROJECT }}');
        expect(source).toContain('SENTRY_ORG: ${{ secrets.SENTRY_ORG }}');
    });

    it('keeps non-shipping CI free of upload and makes production credentials blocking', async () => {
        const source = await workflow('build-target.yml');

        expect(source).toContain('if: ${{ inputs.upload_artifacts }}');
        expect(source).toContain('[ "$EVB_SENTRY_ENVIRONMENT" != \'production\' ]');
        expect(source).toContain('Sentry diagnostics credentials are incomplete or absent for a production build.');
        expect(source).toContain('SENTRY_DESKTOP_DSN: ${{ secrets.SENTRY_DESKTOP_DSN }}');
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
            expect(source).toContain('SENTRY_DESKTOP_PROJECT: ${{ secrets.SENTRY_DESKTOP_PROJECT }}');
            expect(source).toContain('SENTRY_DESKTOP_DSN: ${{ secrets.SENTRY_DESKTOP_DSN }}');
            expect(source).toContain('SENTRY_ORG: ${{ secrets.SENTRY_ORG }}');
        }
    });
});
