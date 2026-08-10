import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    assertAllowedCodexDownloadRedirect,
    assertPinnedCodexArtifactDigest,
    assertPinnedCodexArtifactIdentity,
    downloadPinnedCodexArtifact,
} from '@electron/features/agent/codexCliArtifactDownload';
import {
    PINNED_CODEX_CLI_ARTIFACTS,
    PINNED_CODEX_CLI_RELEASE_TAG,
    PINNED_CODEX_CLI_VERSION,
    resolvePinnedCodexCliArtifact,
} from '@electron/features/agent/codexCliReleaseManifest';
import {
    removeReplacedCodexBackupBestEffort,
    resolveManagedCodexArchiveExtractorPath,
} from '@electron/features/agent/codexCli';

vi.mock('electron', () => ({app: {getPath: () => '/tmp/userData'}}));

const temporaryRoots: string[] = [];

async function createTemporaryRoot() {
    const root = await mkdtemp(join(tmpdir(), 'evb-codex-download-test-'));
    temporaryRoots.push(root);
    return root;
}

describe('pinned Codex CLI artifact policy', () => {
    afterEach(async () => {
        await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
            recursive: true,
            force: true,
        })));
    });

    it('contains a publisher-controlled artifact and digest for every supported target', () => {
        expect(PINNED_CODEX_CLI_RELEASE_TAG).toBe(`rust-v${PINNED_CODEX_CLI_VERSION}`);
        expect(PINNED_CODEX_CLI_ARTIFACTS).toHaveLength(6);
        for (const artifact of PINNED_CODEX_CLI_ARTIFACTS) {
            expect(artifact.url).toBe(
                `https://github.com/openai/codex/releases/download/${PINNED_CODEX_CLI_RELEASE_TAG}/${artifact.assetName}`,
            );
            expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
            expect(resolvePinnedCodexCliArtifact(artifact.platform, artifact.arch)).toBe(artifact);
            expect(() => assertPinnedCodexArtifactIdentity(artifact)).not.toThrow();
        }
    });

    it('rejects publisher, release-version, and manifest-digest substitutions', () => {
        const artifact = PINNED_CODEX_CLI_ARTIFACTS[0]!;
        expect(() => assertPinnedCodexArtifactIdentity({
            ...artifact,
            url: artifact.url.replace('github.com/openai', 'github.com/attacker'),
        })).toThrow('checked-in release manifest');
        expect(() => assertPinnedCodexArtifactIdentity({
            ...artifact,
            url: artifact.url.replace(PINNED_CODEX_CLI_RELEASE_TAG, 'rust-v999.0.0'),
        })).toThrow('checked-in release manifest');
        expect(() => assertPinnedCodexArtifactIdentity({
            ...artifact,
            sha256: '0'.repeat(64),
        })).toThrow('checked-in release manifest');
    });

    it('allows only the expected GitHub release-asset redirect origin', () => {
        const artifact = PINNED_CODEX_CLI_ARTIFACTS[0]!;
        expect(assertAllowedCodexDownloadRedirect(
            artifact.url,
            'https://release-assets.githubusercontent.com/github-production-release-asset/example',
        )).toContain('release-assets.githubusercontent.com');
        expect(() => assertAllowedCodexDownloadRedirect(
            artifact.url,
            'https://objects.example.test/payload',
        )).toThrow('untrusted origin');
        expect(() => assertAllowedCodexDownloadRedirect(
            artifact.url,
            'http://release-assets.githubusercontent.com/payload',
        )).toThrow('untrusted origin');
    });

    it('rejects digest mismatches and removes the downloaded file', async () => {
        const artifact = PINNED_CODEX_CLI_ARTIFACTS[0]!;
        const root = await createTemporaryRoot();
        const destinationPath = join(root, 'codex.tar.gz');
        const fetchImplementation = vi.fn(async () => new Response('not the pinned archive')) as typeof fetch;

        expect(() => assertPinnedCodexArtifactDigest('0'.repeat(64), artifact))
            .toThrow('SHA-256');
        await expect(downloadPinnedCodexArtifact(
            artifact,
            destinationPath,
            fetchImplementation,
        )).rejects.toThrow('SHA-256');
        await expect(readFile(destinationPath)).rejects.toThrow();
    });

    it('rejects redirect-origin changes before downloading a response body', async () => {
        const artifact = PINNED_CODEX_CLI_ARTIFACTS[0]!;
        const root = await createTemporaryRoot();
        const destinationPath = join(root, 'codex.tar.gz');
        const fetchImplementation = vi.fn(async () => new Response(null, {
            status: 302,
            headers: {location: 'https://attacker.example/codex'},
        })) as typeof fetch;

        await expect(downloadPinnedCodexArtifact(
            artifact,
            destinationPath,
            fetchImplementation,
        )).rejects.toThrow('untrusted origin');
        await expect(readFile(destinationPath)).rejects.toThrow();
    });

    it('resolves Windows extraction only through an absolute System32 tar path', () => {
        const pathExists = vi.fn(() => true);

        expect(resolveManagedCodexArchiveExtractorPath(
            'win32',
            {SystemRoot: 'D:\\Windows'},
            pathExists,
        )).toBe('D:\\Windows\\System32\\tar.exe');
        expect(resolveManagedCodexArchiveExtractorPath(
            'win32',
            {SystemRoot: 'D:\\attacker\\Windows'},
            pathExists,
        )).toBe('C:\\Windows\\System32\\tar.exe');
        expect(pathExists).not.toHaveBeenCalledWith('tar.exe');
    });

    it('does not roll back a verified install when stale backup deletion gets Windows EPERM', async () => {
        const removeBackup = vi.fn(async () => {
            const error = new Error('executable is still running');
            Object.assign(error, {code: 'EPERM'});
            throw error;
        });
        const restorePreviousExecutable = vi.fn();
        const targetPath = 'C:\\Users\\evb\\codex\\bin\\codex.exe';
        const backupPath = `${targetPath}.backup`;

        const remainingBackup = await removeReplacedCodexBackupBestEffort(
            backupPath,
            removeBackup,
        );
        if (remainingBackup) {
            restorePreviousExecutable(targetPath, remainingBackup);
        }

        expect(remainingBackup).toBeNull();
        expect(removeBackup).toHaveBeenCalledWith(backupPath, {force: true});
        expect(removeBackup).not.toHaveBeenCalledWith(targetPath, expect.anything());
        expect(restorePreviousExecutable).not.toHaveBeenCalled();
    });
});
