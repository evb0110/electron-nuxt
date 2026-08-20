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
    GetObjectCommand,
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

async function commandBodyBytes(body: unknown): Promise<Buffer> {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
        return Buffer.from(body);
    }
    if (ArrayBuffer.isView(body)) {
        return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function objectBody(bytes: Buffer) {
    return {
        transformToByteArray: async () => bytes,
        transformToString: async () => bytes.toString('utf8'),
    };
}

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
            bytes: Buffer;
            sha256: string
        }>();
        let listPage = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return {
                    ContentLength: object?.bytes.byteLength,
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
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (object) {
                    return {Body: objectBody(object.bytes)};
                }
                const missing = new Error('missing');
                Object.assign(missing, {$metadata: {httpStatusCode: 404}});
                throw missing;
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
            IfNoneMatch: '*',
        });
        expect(puts[2]?.input.IfNoneMatch).toBe('*');
        expect(puts.at(-1)?.input.IfNoneMatch).toBe('*');
        expect(puts.at(-1)?.input.IfMatch).toBeUndefined();
        expect(puts.at(-1)?.input.CacheControl).toBe('no-cache, no-store, must-revalidate');
        expect(deletions[0]?.input.Delete?.Objects).toEqual([{Key: 'evb-viewer/releases/v1.0.0/asset'}]);
        expect(client.send).toHaveBeenCalledTimes(15);
    });

    it('stages immutable release objects without publishing the stable channel', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-stage-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'staged');
        const puts: PutObjectCommand[] = [];
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    return {$metadata: {httpStatusCode: 404}};
                }
                return {
                    ContentLength: object.bytes.byteLength,
                    Metadata: {sha256: object.sha256},
                };
            }
            if (command instanceof GetObjectCommand) {
                const object = stored.get(command.input.Key!);
                if (!object) {
                    throw new Error('Unexpected missing staged object');
                }
                return {Body: objectBody(object.bytes)};
            }
            throw new Error(`Unexpected staging command: ${String(command)}`);
        })};

        const result = await publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.1.0',
            publishChannel: false,
            environment,
            client,
        });

        expect(puts.map(command => command.input.Key)).toEqual([
            'evb-viewer/releases/v2.1.0/asset.zip',
            'evb-viewer/releases/v2.1.0/manifest.json',
        ]);
        expect(result.prunedTags).toEqual([]);
        expect(client.send).not.toHaveBeenCalledWith(expect.any(ListObjectsV2Command));
        expect(client.send).not.toHaveBeenCalledWith(expect.any(DeleteObjectsCommand));
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
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: 999,
                    Metadata: {sha256: 'wrong'},
                };
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('wrong'))};
            }
            return {};
        })};
        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v1.0.0',
            environment,
            client,
        }))
            .rejects.toThrow('Immutable mirror object mismatch');
    });

    it('refuses to overwrite an immutable tagged asset or manifest', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-immutable-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'new bytes');
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: 7,
                    Metadata: {sha256: 'different'},
                };
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                return {};
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('old body'))};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.0',
            publishChannel: false,
            environment,
            client,
        })).rejects.toThrow('Immutable mirror object mismatch');
        expect(puts).toEqual([]);
    });

    it('rejects an existing object whose trusted-looking metadata hides different bytes', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-forged-metadata-'));
        const artifact = Buffer.from('intended bytes');
        await writeFile(join(artifactDirectory, 'asset.zip'), artifact);
        const sha256 = createHash('sha256').update(artifact).digest('hex');
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                return {
                    ContentLength: artifact.byteLength,
                    Metadata: {sha256},
                };
            }
            if (command instanceof GetObjectCommand) {
                return {Body: objectBody(Buffer.from('tampered bytes'))};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.1',
            publishChannel: false,
            environment,
            client,
        })).rejects.toThrow('Immutable mirror object mismatch');
        expect(puts).toEqual([]);
    });

    it.each([
        [
            'accepts',
            Buffer.from('release bytes'),
            true,
        ],
        [
            'rejects',
            Buffer.from('racing attacker'),
            false,
        ],
    ] as const)('%s a concurrent conditional creator according to its downloaded bytes', async (
        _label,
        racingBytes,
        shouldAccept,
    ) => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-race-'));
        const intendedBytes = Buffer.from('release bytes');
        await writeFile(join(artifactDirectory, 'asset.zip'), intendedBytes);
        const stored = new Map<string, Buffer>();
        const puts: PutObjectCommand[] = [];
        const client = {send: vi.fn(async (command: unknown) => {
            const key = command instanceof HeadObjectCommand
                || command instanceof GetObjectCommand
                || command instanceof PutObjectCommand
                ? command.input.Key!
                : '';
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(key);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                expect(command.input.IfNoneMatch).toBe('*');
                if (key.endsWith('/asset.zip')) {
                    stored.set(key, racingBytes);
                    const conflict = new Error('conditional conflict');
                    Object.assign(conflict, {$metadata: {httpStatusCode: 412}});
                    throw conflict;
                }
                stored.set(key, await commandBodyBytes(command.input.Body));
                return {};
            }
            if (command instanceof GetObjectCommand) {
                const bytes = stored.get(key);
                if (!bytes) {
                    throw new Error(`Missing object: ${key}`);
                }
                return {Body: objectBody(bytes)};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        const result = publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v3.0.2',
            publishChannel: false,
            environment,
            client,
        });
        if (shouldAccept) {
            await expect(result).resolves.toMatchObject({assets: [{name: 'asset.zip'}]});
        } else {
            await expect(result).rejects.toThrow('Immutable mirror object mismatch');
        }
        expect(puts[0]?.input.IfNoneMatch).toBe('*');
        expect(stored.get('evb-viewer/releases/v3.0.2/asset.zip')).toEqual(racingBytes);
    });

    it('refuses to move the stable channel backward', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-downgrade-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'release');
        const puts: PutObjectCommand[] = [];
        const stored = new Map<string, {
            bytes: Buffer;
            sha256: string
        }>();
        const client = {send: vi.fn(async (command: unknown) => {
            if (command instanceof HeadObjectCommand) {
                const object = stored.get(command.input.Key!);
                return object
                    ? {
                        ContentLength: object.bytes.byteLength,
                        Metadata: {sha256: object.sha256},
                    }
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof PutObjectCommand) {
                puts.push(command);
                stored.set(command.input.Key!, {
                    bytes: await commandBodyBytes(command.input.Body),
                    sha256: command.input.Metadata!.sha256!,
                });
                return {};
            }
            if (command instanceof GetObjectCommand) {
                const storedObject = stored.get(command.input.Key!);
                if (storedObject) {
                    return {Body: objectBody(storedObject.bytes)};
                }
                return {Body: {transformToString: async () => JSON.stringify({release: {tag: 'v3.0.0'}})}};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.9.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to move stable mirror backward');
        expect(puts.map(command => command.input.Key)).not.toContain('evb-viewer/channels/stable.json');
    });

    it('uses the stable channel ETag and rejects a concurrent downgrade race', async () => {
        const artifactDirectory = await mkdtemp(join(tmpdir(), 'evb-mirror-channel-race-'));
        await writeFile(join(artifactDirectory, 'asset.zip'), 'release');
        const stored = new Map<string, Buffer>();
        let stableReadCount = 0;
        const client = {send: vi.fn(async (command: unknown) => {
            const key = command instanceof HeadObjectCommand
                || command instanceof GetObjectCommand
                || command instanceof PutObjectCommand
                ? command.input.Key!
                : '';
            if (command instanceof HeadObjectCommand) {
                const bytes = stored.get(key);
                return bytes
                    ? {ContentLength: bytes.byteLength}
                    : {$metadata: {httpStatusCode: 404}};
            }
            if (command instanceof GetObjectCommand) {
                if (key === 'evb-viewer/channels/stable.json') {
                    stableReadCount += 1;
                    const tag = stableReadCount === 1 ? 'v1.9.0' : 'v2.1.0';
                    return {
                        Body: objectBody(Buffer.from(JSON.stringify({release: {tag}}))),
                        ETag: stableReadCount === 1 ? '"old"' : '"new"',
                    };
                }
                const bytes = stored.get(key);
                if (!bytes) {
                    throw new Error(`Missing object: ${key}`);
                }
                return {Body: objectBody(bytes)};
            }
            if (command instanceof PutObjectCommand) {
                if (key === 'evb-viewer/channels/stable.json') {
                    expect(command.input.IfMatch).toBe('"old"');
                    const conflict = new Error('conditional conflict');
                    Object.assign(conflict, {$metadata: {httpStatusCode: 412}});
                    throw conflict;
                }
                stored.set(key, await commandBodyBytes(command.input.Body));
                return {};
            }
            throw new Error(`Unexpected command: ${String(command)}`);
        })};

        await expect(publishReleaseMirror({
            artifactDirectory,
            releaseTag: 'v2.0.0',
            environment,
            client,
        })).rejects.toThrow('Refusing to move stable mirror backward from v2.1.0 to v2.0.0');
        expect(stableReadCount).toBe(2);
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
        expect(compareReleaseTags('v1.0.0', 'v1.0.0-beta.9')).toBeGreaterThan(0);
        expect(compareReleaseTags('v1.0.0-rc.2', 'v1.0.0-rc.10')).toBeLessThan(0);

        const directory = await mkdtemp(join(tmpdir(), 'evb-mirror-hash-'));
        const filePath = join(directory, 'asset');
        await writeFile(filePath, 'content');
        expect(await hashFile(filePath)).toBe(createHash('sha256').update('content').digest('hex'));
    });
});
