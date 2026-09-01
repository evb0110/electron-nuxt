import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {execFileSync} from 'node:child_process';
import {
    copyFile,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
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

    it('loads without the optional S3 mirror dependency in a clean checkout', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-asset-import-'));
        directories.push(directory);
        const releaseDirectory = join(process.cwd(), 'scripts', 'release');
        await Promise.all([
            'ensure-github-release-assets.mjs',
            'policy.mjs',
            'publish-release-mirror.mjs',
            'release-hash.mjs',
            'releaseTag.mjs',
        ].map(name => copyFile(join(releaseDirectory, name), join(directory, name))));

        const output = execFileSync(process.execPath, [
            '--input-type=module',
            '--eval',
            'await import(process.argv[1]); process.stdout.write("loaded")',
            pathToFileURL(join(directory, 'ensure-github-release-assets.mjs')).href,
        ], {encoding: 'utf8'});

        expect(output).toBe('loaded');
    });
});
