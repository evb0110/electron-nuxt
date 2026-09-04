import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    WINDOWS_TEST_RUNNER_VERSION,
    WINDOWS_TEST_SCHEMA_VERSION,
    type IWindowsTestJob,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    guestLayoutForRoot,
    guestRunPaths,
    joinGuestPath,
} from '@scripts/windows-test/guest/guestPaths';
import {
    createNodeGuestFileSystem,
    sha256HexOfText,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    isGuestTestMarkerRecord,
    isSafeStagedFileName,
    validateGuestJob,
} from '@scripts/windows-test/guest/guestJobValidation';

const runId = '20260904T120000Z-0123456789ab';
const vmId = '11111111-2222-4333-8444-555555555555';
const sourceSha = 'b'.repeat(40);
const artifactContents = 'installer-bytes';
const manifestContents = '{"schemaVersion":1,"packs":[]}';
const fs = createNodeGuestFileSystem();

function buildJob(overrides: Partial<IWindowsTestJob> = {}): IWindowsTestJob {
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        runId,
        sourceSha,
        artifactSha256: sha256HexOfText(artifactContents),
        artifactFileName: 'EVB-Viewer-Setup-arm64.exe',
        imageId: 'win11-arm64-pro-25h2-baseline-001',
        vmId,
        bootId: 'boot-42',
        guestTestMarker: 'evb-test-clone',
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        suite: 'critical',
        tests: ['WIN-SAVE-01'],
        fixtureManifestSha256: sha256HexOfText(manifestContents),
        expectedOsArch: 'arm64',
        expectedAppArch: 'arm64',
        deadlineSeconds: 900,
        ...overrides,
    };
}

let root = '';

async function stageGuest(options: {
    bootId?: string;
    marker?: string;
    artifactFileName?: string;
    artifactContents?: string;
    manifestContents?: string;
} = {}) {
    const layout = guestLayoutForRoot(root, '/');
    const paths = guestRunPaths(layout, runId);
    await fs.writeText(layout.bootIdFile, `${options.bootId ?? 'boot-42'}\n`);
    await fs.writeText(layout.markerFile, JSON.stringify({
        guestTestMarker: options.marker ?? 'evb-test-clone',
        imageId: 'win11-arm64-pro-25h2-baseline-001',
    }));
    await fs.writeText(
        joinGuestPath('/', paths.stagingDir, options.artifactFileName ?? 'EVB-Viewer-Setup-arm64.exe'),
        options.artifactContents ?? artifactContents,
    );
    await fs.writeText(paths.fixtureManifestFile, options.manifestContents ?? manifestContents);
    return {
        layout,
        paths,
    };
}

describe('guest job validation', () => {
    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-guest-job-'));
    });

    it('accepts a job whose staged inputs all match', async () => {
        const staged = await stageGuest();
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(true);
    });

    it('rejects a payload that is not a job at all', async () => {
        const staged = await stageGuest();
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: { hello: 'world' },
        });
        expect(validation).toMatchObject({
            ok: false,
            job: null,
        });
    });

    it('names the unsupported schema version explicitly', async () => {
        const staged = await stageGuest();
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: {
                ...buildJob(),
                schemaVersion: 2,
            },
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('unsupported schemaVersion 2');
    });

    it.each([
        [
            'a run id that disagrees with the ready marker',
            () => buildJob({ runId: '20260904T130000Z-0123456789ab' }),
            'does not match ready marker',
        ],
        [
            'a runner version the guest does not have installed',
            () => buildJob({ runnerVersion: '1999-01-01.1' }),
            'is not the installed worker version',
        ],
        [
            'an artifact file name that is really a path',
            () => buildJob({ artifactFileName: '..\\..\\windows\\system32\\evil.exe' }),
            'is not a plain staged file name',
        ],
        [
            'a boot id from a previous boot',
            () => buildJob({ bootId: 'boot-1' }),
            'does not match the current guest boot',
        ],
        [
            'a guest marker from another image',
            () => buildJob({ guestTestMarker: 'production-clone' }),
            'does not match the provisioned guest marker',
        ],
        [
            'an artifact hash that disagrees with the staged bytes',
            () => buildJob({ artifactSha256: 'c'.repeat(64) }),
            'does not match the job value',
        ],
        [
            'a fixture manifest hash that disagrees with the staged manifest',
            () => buildJob({ fixtureManifestSha256: 'd'.repeat(64) }),
            'does not match the job value',
        ],
    ])('rejects %s', async (_label, makeJob, expectedReason) => {
        const staged = await stageGuest();
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: makeJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain(expectedReason);
    });

    it('refuses a second execution of the same run id', async () => {
        const staged = await stageGuest();
        await fs.writeText(staged.paths.startedMarkerFile, 'started');
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('duplicate execution refused');
    });

    it('rejects a missing boot id file before it looks at anything else', async () => {
        const layout = guestLayoutForRoot(root, '/');
        const validation = await validateGuestJob({
            fs,
            layout,
            paths: guestRunPaths(layout, runId),
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('boot id file is missing');
    });

    it('rejects a malformed guest marker file', async () => {
        const staged = await stageGuest();
        await fs.writeText(staged.layout.markerFile, 'not json');
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('marker file is missing or malformed');
    });

    it('rejects a job whose staged artifact was never delivered', async () => {
        const staged = await stageGuest({ artifactFileName: 'other-installer.exe' });
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('is missing');
    });

    it('rejects a missing staged fixture manifest', async () => {
        const staged = await stageGuest();
        await fs.remove(staged.paths.fixtureManifestFile);
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: staged.paths,
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('fixture manifest is missing');
    });

    it('refuses run paths that resolve outside the guest root', async () => {
        const staged = await stageGuest();
        const validation = await validateGuestJob({
            fs,
            layout: staged.layout,
            paths: {
                ...staged.paths,
                runRoot: '/etc',
            },
            markerRunId: runId,
            rawJob: buildJob(),
        });
        expect(validation.ok).toBe(false);
        expect(validation.ok ? '' : validation.reason).toContain('outside the guest test root');
    });

    it('classifies staged file names and marker records', () => {
        expect(isSafeStagedFileName('setup.exe')).toBe(true);
        expect(isSafeStagedFileName('..')).toBe(false);
        expect(isSafeStagedFileName('sub/dir.exe')).toBe(false);
        expect(isSafeStagedFileName('C:evil.exe')).toBe(false);
        expect(isGuestTestMarkerRecord({
            guestTestMarker: 'evb-test-clone',
            imageId: 'image',
        })).toBe(true);
        expect(isGuestTestMarkerRecord({ guestTestMarker: '' })).toBe(false);
    });
});
