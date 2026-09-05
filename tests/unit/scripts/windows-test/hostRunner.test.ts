import { createHash } from 'node:crypto';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import { resolveWindowsTestCandidate } from '@scripts/windows-test/host/hostRunner';

const ARTIFACT = 'candidate-installer-bytes';
const ARTIFACT_SHA256 = createHash('sha256').update(ARTIFACT).digest('hex');

function hostConfig(artifactPath: string, sha256 = ARTIFACT_SHA256): IWindowsTestHostConfig {
    return {
        schemaVersion: 1,
        testImageRoot: '/tmp/windows-test-images',
        allowedTestVmIds: [],
        goldenImageId: 'win11-arm64-2026-09',
        goldenVmId: '11111111-2222-4333-8444-555555555555',
        personalVmIdsDenied: [],
        candidate: {
            artifactPath,
            sha256,
            fileName: path.basename(artifactPath),
            version: '3.4.5',
            sourceSha: 'b'.repeat(40),
            appArch: 'arm64',
        },
        environment: 'utm-win11-arm64-app-arm64',
        qualifiedLaunchers: ['/Applications/EVB Viewer.app'],
        retention: {
            passDays: 3,
            failureDays: 14,
            maxFailedClones: 0,
            minFreeBytes: 1_024,
        },
    };
}

describe('windows test candidate resolution', () => {
    let root = '';

    afterEach(async () => {
        if (root !== '') {
            await rm(root, {
                force: true,
                recursive: true,
            });
            root = '';
        }
    });

    it('keeps the registered identity when the configured artifact still hashes as recorded', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const artifactPath = path.join(root, 'candidate.exe');
        await writeFile(artifactPath, ARTIFACT, 'utf8');
        const config = hostConfig(artifactPath);

        await expect(resolveWindowsTestCandidate(config, artifactPath)).resolves.toEqual(config.candidate);
    });

    it('rejects a configured artifact that was replaced under the same path', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const artifactPath = path.join(root, 'candidate.exe');
        await writeFile(artifactPath, 'different-binary', 'utf8');

        await expect(resolveWindowsTestCandidate(hostConfig(artifactPath), artifactPath))
            .rejects.toThrow(/config\.json records/u);
    });

    it('requires sidecar identity for an artifact path that is not configured', async () => {
        root = await mkdtemp(path.join(tmpdir(), 'evb-windows-candidate-'));
        const configuredPath = path.join(root, 'configured.exe');
        const overridePath = path.join(root, 'override.exe');
        await writeFile(configuredPath, ARTIFACT, 'utf8');
        await writeFile(overridePath, ARTIFACT, 'utf8');
        await writeFile(`${overridePath}.meta.json`, JSON.stringify({
            version: '3.4.6',
            sourceSha: 'c'.repeat(40),
            appArch: 'arm64',
        }), 'utf8');

        await expect(resolveWindowsTestCandidate(hostConfig(configuredPath), overridePath))
            .resolves.toMatchObject({
                artifactPath: overridePath,
                sha256: ARTIFACT_SHA256,
                version: '3.4.6',
                sourceSha: 'c'.repeat(40),
            });
    });
});
