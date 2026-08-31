import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    assertImmutableAsset,
    ensureGithubReleaseAssets,
} from '@scripts/release/ensure-github-release-assets.mjs';

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
}))));

describe('immutable GitHub release assets', () => {
    it('accepts byte-identical retries', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-immutable-assets-'));
        directories.push(directory);
        const localPath = join(directory, 'local.zip');
        const remotePath = join(directory, 'remote.zip');
        await writeFile(localPath, 'release bytes\n');
        await writeFile(remotePath, 'release bytes\n');

        await expect(assertImmutableAsset(localPath, remotePath)).resolves.toMatch(/^[a-f\d]{64}$/u);
    });

    it('rejects a same-name replacement with different bytes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-immutable-assets-'));
        directories.push(directory);
        const localPath = join(directory, 'local.zip');
        const remotePath = join(directory, 'remote.zip');
        await writeFile(localPath, 'new release bytes\n');
        await writeFile(remotePath, 'old release bytes\n');

        await expect(assertImmutableAsset(localPath, remotePath)).rejects.toThrow(
            'Immutable release asset mismatch',
        );
    });

    it('rejects release tags outside the shared release-tag grammar', async () => {
        await expect(ensureGithubReleaseAssets({
            assetPaths: ['missing.dmg'],
            repo: 'evb0110/evb-viewer',
            tag: '../latest',
        })).rejects.toThrow('Usage: ensure-github-release-assets.mjs');
    });
});
