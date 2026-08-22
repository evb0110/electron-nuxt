import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
    mkdtemp,
    mkdir,
    readFile,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    generateReleaseChecksums,
    parseChecksumManifest,
    validateReleaseAssetNames,
    verifyReleaseChecksums,
} from '@scripts/release/release-checksums.mjs';

const sha256 = (contents: string) => createHash('sha256').update(contents).digest('hex');

describe('release checksum manifest', () => {
    it('generates deterministic checksums for the exact release asset set and verifies them', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-'));
        await writeFile(join(directory, 'z archive.zip'), 'zip');
        await writeFile(join(directory, 'EVB Viewer.exe'), 'exe');

        const generated = await generateReleaseChecksums(directory);

        expect(generated.assetNames).toEqual([
            'EVB Viewer.exe',
            'z archive.zip',
        ]);
        expect(await readFile(join(directory, 'SHA256SUMS'), 'utf8')).toBe([
            `${sha256('exe')}  EVB Viewer.exe`,
            `${sha256('zip')}  z archive.zip`,
            '',
        ].join('\n'));
        await expect(verifyReleaseChecksums(directory)).resolves.toEqual({assetNames: [
            'EVB Viewer.exe',
            'z archive.zip',
        ]});
    });

    it('rejects changed bytes and both missing and unlisted release assets', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-tamper-'));
        await writeFile(join(directory, 'asset.zip'), 'original');
        await generateReleaseChecksums(directory);
        await writeFile(join(directory, 'asset.zip'), 'tampered');
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'Checksum mismatch for release asset: asset.zip',
        );

        await writeFile(join(directory, 'asset.zip'), 'original');
        await writeFile(join(directory, 'extra.dmg'), 'extra');
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'missing: extra.dmg; unexpected: (none)',
        );

        await writeFile(join(directory, 'SHA256SUMS'), [
            `${sha256('original')}  asset.zip`,
            `${sha256('ghost')}  ghost.AppImage`,
            '',
        ].join('\n'));
        await expect(verifyReleaseChecksums(directory)).rejects.toThrow(
            'missing: extra.dmg; unexpected: ghost.AppImage',
        );
    });

    it('rejects duplicate, traversing, ambiguous, and malformed manifest basenames', () => {
        expect(() => parseChecksumManifest([
            `${sha256('a')}  Asset.zip`,
            `${sha256('b')}  asset.zip`,
            '',
        ].join('\n'))).toThrow('Duplicate release asset basename');
        expect(() => parseChecksumManifest(`${sha256('a')}  ../asset.zip\n`)).toThrow(
            'Unsafe release asset basename',
        );
        expect(() => parseChecksumManifest(`${sha256('a')}  SHA256sums\n`)).toThrow(
            'Unsafe release asset basename',
        );
        expect(() => parseChecksumManifest(`${sha256('a')} *asset.zip\n`)).toThrow(
            'Invalid SHA256SUMS line',
        );
        expect(() => parseChecksumManifest(`${sha256('a')}  asset.zip`)).toThrow(
            'end with a newline',
        );
    });

    it('rejects non-portable duplicate asset filenames without relying on filesystem case sensitivity', () => {
        expect(() => validateReleaseAssetNames([
            'Asset.zip',
            'asset.zip',
        ])).toThrow(
            'Release asset basenames are not portable and unique',
        );
    });

    it('rejects an empty asset-name list without assuming a filesystem caller', () => {
        expect(() => validateReleaseAssetNames([])).toThrow(
            'Release asset names must not be empty',
        );
    });

    it('propagates regular-file basename policy through checksum generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-unsafe-name-'));
        await writeFile(join(directory, 'asset.zip '), 'asset');

        await expect(generateReleaseChecksums(directory)).rejects.toThrow(
            'Unsafe release asset basename: "asset.zip "',
        );
    });

    it('rejects non-regular entries in real artifact directories', async () => {
        const nestedDirectory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-nested-'));
        await writeFile(join(nestedDirectory, 'asset.zip'), 'asset');
        await mkdir(join(nestedDirectory, 'nested '));
        await expect(generateReleaseChecksums(nestedDirectory)).rejects.toThrow(
            'Release artifact must be a regular file: "nested "',
        );

        const linkedDirectory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-link-'));
        await writeFile(join(linkedDirectory, 'asset.zip'), 'asset');
        await symlink(join(linkedDirectory, 'asset.zip'), join(linkedDirectory, 'linked.zip '));
        await expect(generateReleaseChecksums(linkedDirectory)).rejects.toThrow(
            'Release artifact must be a regular file: "linked.zip "',
        );
    });

    it.skipIf(process.platform === 'win32')('rejects unsafe Unix socket entries as non-regular files', async () => {
        const socketDirectory = await mkdtemp(join(tmpdir(), 'evb-release-checksums-socket-'));
        await writeFile(join(socketDirectory, 'asset.zip'), 'asset');
        const socketPath = join(socketDirectory, 'release.sock ');
        const server = createServer();
        server.listen(socketPath);
        await once(server, 'listening');
        try {
            await expect(generateReleaseChecksums(socketDirectory)).rejects.toThrow(
                'Release artifact must be a regular file: "release.sock "',
            );
        } finally {
            const closePromise = once(server, 'close');
            server.close();
            await closePromise;
        }
    });
});
