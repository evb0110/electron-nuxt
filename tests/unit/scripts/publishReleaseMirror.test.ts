import { createHash } from 'node:crypto';
import {
    mkdtemp,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    compareReleaseTags,
    contentTypeFor,
    hashFile,
    publishReleaseMirror,
    requireEnvironment,
    versionParts,
} from '@scripts/release/publish-release-mirror.mjs';

const environment = {
    MIRROR_S3_ENDPOINT: 'https://mirror.example.test',
    MIRROR_S3_BUCKET: 'releases',
    MIRROR_S3_ACCESS_KEY_ID: 'access',
    MIRROR_S3_SECRET_KEY: 'secret',
};

describe('release mirror publisher', () => {
    it('uploads verified artifacts and JSON pointers before pruning stale releases', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-'));
        await writeFile(join(artifactDirectory, 'EVB Viewer.exe'), 'windows');
        await writeFile(join(artifactDirectory, 'latest.yml'), 'version: 1');
        await writeFile(join(artifactDirectory, '.ignored'), 'hidden');
        await mkdir(join(artifactDirectory, 'nested'));

        const puts: PutObjectCommand[] = [];
        const deletions: DeleteObjectsCommand[] = [];
        const stored = new Map<string, {
            size: number;
            sha256: string
        }>();
        let listPage = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    size: command.input.ContentLength!,
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return {
                    ContentLength: object?.size,
                    Metadata: {sha256: object?.sha256},
                };
            }
            if (command instanceof ListObjectsV2Command) {
                listPage += 1;
                return listPage === 1
                    ? {
                        Contents: [
                            'v1.0.0',
                            'v1.1.0',
                            'v1.2.0',
                        ].map(tag => ({Key: `evb-viewer/releases/${tag}/asset`})),
                        NextContinuationToken: 'page-2',
                    }
                    : {Contents: [
                        {Key: 'evb-viewer/releases/v1.3.0/asset'},
                        {Key: 'evb-viewer/releases/v2.0.0/asset'},
                        {Key: 'evb-viewer/releases/not-a-version/asset'},
                    ]};
            }
            if (command instanceof DeleteObjectsCommand) {
                deletions.push(command);
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        const result = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.0.0',
            environment,
            client,
        });

        expect(result.assets.map(asset => asset.name)).toEqual([
            'EVB Viewer.exe',
            'latest.yml',
        ]);
        expect(result.prunedTags).toEqual(['v1.0.0']);
        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.0.0/EVB Viewer.exe',
            'evb-viewer/releases/v2.0.0/latest.yml',
            'evb-viewer/releases/v2.0.0/manifest.json',
            'evb-viewer/channels/stable.json',
        ]);
        expect(puts[0]?.input).toMatchObject({
            Bucket: 'releases',
            ContentLength: 7,
            ContentType: 'application/vnd.microsoft.portable-executable',
            CacheControl: 'public, max-age=31536000, immutable',
        });
        expect(puts.at(-1)?.input.CacheControl).toBe('no-cache, no-store, must-revalidate');
        expect(deletions[0]?.input.Delete?.Objects).toEqual([{Key: 'evb-viewer/releases/v1.0.0/asset'}]);
        expect(client.send).toHaveBeenCalledTimes(13);
    });

    it('rejects invalid input, missing credentials, empty folders, and verification mismatches', async () => {
        await expect(publishReleaseMirror({
            artifactDirectory: '',
            releaseTag: '',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('Usage:');
        await expect(publishReleaseMirror({
            artifactDirectory: '/tmp',
            releaseTag: 'latest',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('Invalid release tag');
        expect(() => requireEnvironment({}, 'MIRROR_S3_BUCKET')).toThrow('Missing required environment variable');

        const emptyDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-empty-'));
        await writeFile(join(emptyDirectory, '.ignored'), 'hidden');
        await expect(publishReleaseMirror({
            artifactDirectory: emptyDirectory,
            releaseTag: 'v1.0.0',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('No release artifacts');

        const directoryOnly = await mkdtemp(join(tmpdir(), 'evb-mirror-directory-'));
        await mkdir(join(directoryOnly, 'nested'));
        await expect(publishReleaseMirror({
            artifactDirectory: directoryOnly,
            releaseTag: 'v1.0.0',
            environment,
            client: {send: vi.fn()},
        }))
            .rejects.toThrow('No regular release artifact files');

        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-invalid-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'zip');
        const client = {send: vi.fn(async (command: unknown) => command instanceof HeadObjectCommand
            ? {
                ContentLength: 999,
                Metadata: {sha256: 'wrong'},
            }
            : {})};
        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v1.0.0',
            environment,
            client,
        }))
            .rejects.toThrow('Mirror verification failed');
    });

    it('maps content types, compares release tags, and hashes files deterministically', async () => {
        expect(contentTypeFor('app.dmg')).toBe('application/x-apple-diskimage');
        expect(contentTypeFor('app.AppImage')).toBe('application/octet-stream');
        expect(contentTypeFor('app.deb')).toBe('application/vnd.debian.binary-package');
        expect(contentTypeFor('app.zip')).toBe('application/zip');
        expect(contentTypeFor('manifest.json')).toBe('application/json');
        expect(contentTypeFor('notes.txt')).toBe('application/octet-stream');
        expect(versionParts('v12.3.4-beta.1')).toEqual([
            12,
            3,
            4,
        ]);
        expect(compareReleaseTags('v2.0.0', 'v1.9.9')).toBeGreaterThan(0);
        expect(compareReleaseTags('v1.0.0-beta', 'v1.0.0-alpha')).toBeGreaterThan(0);

        const directory = await mkdtemp(join(tmpdir(), 'evb-mirror-hash-'));
        const filePath = join(directory, 'asset');
        await writeFile(filePath, 'content');
        expect(await hashFile(filePath)).toBe(createHash('sha256').update('content').digest('hex'));
    });
});
