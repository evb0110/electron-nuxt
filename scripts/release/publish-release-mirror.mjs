import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    readdir,
    stat,
} from 'node:fs/promises';
import {
    basename,
    join,
} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';

const RELEASE_PREFIX = 'evb-viewer/releases/';
const CHANNEL_KEY = 'evb-viewer/channels/stable.json';
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const RETAINED_RELEASE_COUNT = 4;

export async function publishReleaseMirror({
    artifactDirectory,
    releaseTag,
    publishChannel = true,
    environment = process.env,
    client: providedClient,
}) {
    if (!artifactDirectory || !releaseTag) {
        throw new Error('Usage: publish-release-mirror.mjs <artifact-directory> <release-tag>');
    }
    if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
        throw new Error(`Invalid release tag: ${releaseTag}`);
    }

    const endpoint = requireEnvironment(environment, 'MIRROR_S3_ENDPOINT');
    const bucket = requireEnvironment(environment, 'MIRROR_S3_BUCKET');
    const client = providedClient ?? new S3Client({
        endpoint,
        region: environment.MIRROR_S3_REGION || 'ru-central1',
        // Yandex implements the S3 API but not every optional AWS checksum mode.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        credentials: {
            accessKeyId: requireEnvironment(environment, 'MIRROR_S3_ACCESS_KEY_ID'),
            secretAccessKey: requireEnvironment(environment, 'MIRROR_S3_SECRET_KEY'),
        },
    });

    const artifactNames = (await readdir(artifactDirectory))
        .filter(name => !name.startsWith('.'))
        .sort((left, right) => left.localeCompare(right));

    if (artifactNames.length === 0) {
        throw new Error(`No release artifacts found in ${artifactDirectory}`);
    }

    const assets = [];
    for (const name of artifactNames) {
        const filePath = join(artifactDirectory, name);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) {
            continue;
        }

        const sha256 = await hashFile(filePath);
        const key = `${RELEASE_PREFIX}${releaseTag}/${name}`;
        const existingState = await immutableUploadState(client, bucket, key, fileStat.size, sha256);
        if (existingState === 'match') {
            console.log(`Already verified ${name} (${fileStat.size} bytes)`);
        } else if (existingState === 'mismatch') {
            throw new Error(`Immutable mirror object mismatch for ${key}`);
        } else {
            console.log(`Uploading ${name} (${fileStat.size} bytes)`);
            await putImmutableObject(client, bucket, key, new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: createReadStream(filePath),
                ContentLength: fileStat.size,
                ContentType: contentTypeFor(name),
                CacheControl: 'public, max-age=31536000, immutable',
                Metadata: { sha256 },
                IfNoneMatch: '*',
            }), fileStat.size, sha256);
        }
        assets.push({
            name,
            size: fileStat.size,
            sha256,
        });
    }

    if (assets.length === 0) {
        throw new Error(`No regular release artifact files found in ${artifactDirectory}`);
    }

    const manifest = JSON.stringify({
        schemaVersion: 1,
        release: { tag: releaseTag },
        assets,
    }, null, 2);
    await putImmutableJson(
        client,
        bucket,
        `${RELEASE_PREFIX}${releaseTag}/manifest.json`,
        manifest,
        'public, max-age=31536000, immutable',
    );

    let prunedTags = [];
    if (publishChannel) {
        // Publish the mutable channel pointer last, after every immutable object
        // has been uploaded and verified. Clients cannot discover a partial release.
        await publishStableChannel(client, bucket, manifest, releaseTag, environment);
        prunedTags = await pruneOldReleases(client, bucket, releaseTag);
        console.log(`Mirror published ${releaseTag}; retained ${RETAINED_RELEASE_COUNT} releases${
            prunedTags.length ? ` and pruned ${prunedTags.join(', ')}` : ''
        }`);
    } else {
        console.log(`Mirror staged ${releaseTag}; stable channel remains unchanged.`);
    }
    return {
        assets,
        manifest,
        prunedTags,
    };
}

export function requireEnvironment(environment, name) {
    const value = environment[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export async function hashFile(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function objectMatches(client, bucket, key, expectedSize, expectedSha256) {
    const result = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    const actual = await hashObjectBody(result.Body);
    return actual.size === expectedSize && actual.sha256 === expectedSha256;
}

async function verifyUpload(client, bucket, key, expectedSize, expectedSha256) {
    if (!await objectMatches(client, bucket, key, expectedSize, expectedSha256)) {
        throw new Error(`Mirror verification failed for ${key}`);
    }
}

async function hashObjectBody(body) {
    if (!body) {
        throw new Error('Mirror object response has no body');
    }
    const hash = createHash('sha256');
    let size = 0;
    if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(bytes);
            size += bytes.byteLength;
        }
    } else if (typeof body.transformToByteArray === 'function') {
        const bytes = Buffer.from(await body.transformToByteArray());
        hash.update(bytes);
        size = bytes.byteLength;
    } else if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
        const bytes = Buffer.from(body);
        hash.update(bytes);
        size = bytes.byteLength;
    } else {
        throw new Error('Mirror object response body cannot be read');
    }
    return {
        sha256: hash.digest('hex'),
        size,
    };
}

async function immutableUploadState(client, bucket, key, expectedSize, expectedSha256) {
    try {
        const result = await client.send(new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
        }));
        if (result.$metadata?.httpStatusCode === 404 || result.ContentLength === undefined) {
            return 'missing';
        }
        return await objectMatches(client, bucket, key, expectedSize, expectedSha256)
            ? 'match'
            : 'mismatch';
    } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
            return 'missing';
        }
        throw error;
    }
}

async function putImmutableObject(client, bucket, key, command, expectedSize, expectedSha256) {
    try {
        await client.send(command);
    } catch (error) {
        if (!isConditionalWriteConflict(error)) {
            throw error;
        }
        if (await objectMatches(client, bucket, key, expectedSize, expectedSha256)) {
            return;
        }
        throw new Error(`Immutable mirror object mismatch for ${key}`, {cause: error});
    }
    await verifyUpload(client, bucket, key, expectedSize, expectedSha256);
}

function isConditionalWriteConflict(error) {
    return error?.$metadata?.httpStatusCode === 409
        || error?.$metadata?.httpStatusCode === 412
        || error?.name === 'ConditionalRequestConflict'
        || error?.name === 'PreconditionFailed';
}

async function putImmutableJson(client, bucket, key, body, cacheControl) {
    const size = Buffer.byteLength(body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const existingState = await immutableUploadState(client, bucket, key, size, sha256);
    if (existingState === 'match') {
        return;
    }
    if (existingState === 'mismatch') {
        throw new Error(`Immutable mirror object mismatch for ${key}`);
    }
    await putImmutableObject(client, bucket, key, new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: cacheControl,
        Metadata: { sha256 },
        IfNoneMatch: '*',
    }), size, sha256);
}

async function publishStableChannel(client, bucket, body, releaseTag, environment) {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const size = Buffer.byteLength(body);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const current = await readStableChannel(client, bucket);
        if (
            current
            && compareReleaseTags(releaseTag, current.tag) < 0
            && environment.EVB_ALLOW_RELEASE_ROLLBACK !== '1'
        ) {
            throw new Error(
                `Refusing to move stable mirror backward from ${current.tag} to ${releaseTag}`,
            );
        }
        if (current?.size === size && current.sha256 === sha256) {
            return;
        }
        if (current && !current.etag) {
            throw new Error('Stable mirror object response has no ETag; refusing an unguarded update');
        }
        try {
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: CHANNEL_KEY,
                Body: body,
                ContentLength: size,
                ContentType: 'application/json; charset=utf-8',
                CacheControl: 'no-cache, no-store, must-revalidate',
                Metadata: { sha256 },
                ...(current
                    ? {IfMatch: current.etag}
                    : {IfNoneMatch: '*'}),
            }));
            await verifyUpload(client, bucket, CHANNEL_KEY, size, sha256);
            return;
        } catch (error) {
            if (!isConditionalWriteConflict(error)) {
                throw error;
            }
            if (attempt === 5) {
                throw new Error('Stable mirror channel changed repeatedly during publication', {cause: error});
            }
            await delay(25 * attempt);
        }
    }
}

async function readStableChannel(client, bucket) {
    let response;
    try {
        response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: CHANNEL_KEY,
        }));
    } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') {
            return null;
        }
        throw error;
    }
    const raw = await response.Body?.transformToString();
    if (typeof raw !== 'string') {
        throw new Error('Stable mirror object response has no readable body');
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error('Stable mirror object is not valid JSON', {cause: error});
    }
    const tag = parsed?.release?.tag;
    if (typeof tag !== 'string' || !RELEASE_TAG_PATTERN.test(tag)) {
        throw new Error('Stable mirror object has an invalid release tag');
    }
    return {
        etag: response.ETag,
        sha256: createHash('sha256').update(raw).digest('hex'),
        size: Buffer.byteLength(raw),
        tag,
    };
}

async function pruneOldReleases(client, bucket, protectedTag) {
    const objects = await listAllReleaseObjects(client, bucket);
    const tags = [...new Set(objects.map(object => object.Key?.slice(RELEASE_PREFIX.length).split('/')[0]).filter(Boolean))]
        .filter(tag => RELEASE_TAG_PATTERN.test(tag))
        .sort(compareReleaseTags)
        .reverse();
    const retainedTags = new Set(tags.slice(0, RETAINED_RELEASE_COUNT));
    retainedTags.add(protectedTag);
    const staleTags = tags.filter(tag => !retainedTags.has(tag));
    const staleKeys = objects
        .map(object => object.Key)
        .filter(key => key && staleTags.some(tag => key.startsWith(`${RELEASE_PREFIX}${tag}/`)));

    for (let index = 0; index < staleKeys.length; index += 1_000) {
        const batch = staleKeys.slice(index, index + 1_000);
        const result = await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: batch.map(Key => ({ Key })),
                Quiet: true,
            },
        }));
        if ((result.Errors ?? []).length > 0) {
            throw new Error(`Mirror pruning failed for ${result.Errors.map(error => error.Key ?? 'unknown').join(', ')}`);
        }
    }
    return staleTags;
}

async function listAllReleaseObjects(client, bucket) {
    const objects = [];
    let continuationToken;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: RELEASE_PREFIX,
            ContinuationToken: continuationToken,
        }));
        objects.push(...(page.Contents ?? []));
        continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return objects;
}

export function compareReleaseTags(left, right) {
    const leftVersion = parseReleaseVersion(left);
    const rightVersion = parseReleaseVersion(right);
    for (let index = 0; index < 3; index++) {
        const comparison = leftVersion.core[index] - rightVersion.core[index];
        if (comparison !== 0) {
            return comparison;
        }
    }
    if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
        return leftVersion.prerelease.length === rightVersion.prerelease.length
            ? 0
            : leftVersion.prerelease.length === 0 ? 1 : -1;
    }
    const identifierCount = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < identifierCount; index++) {
        const leftIdentifier = leftVersion.prerelease[index];
        const rightIdentifier = rightVersion.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) {
            return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
        }
        const leftNumeric = /^\d+$/u.test(leftIdentifier);
        const rightNumeric = /^\d+$/u.test(rightIdentifier);
        if (leftNumeric && rightNumeric) {
            const comparison = Number(leftIdentifier) - Number(rightIdentifier);
            if (comparison !== 0) {
                return comparison;
            }
        } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        } else {
            if (leftIdentifier !== rightIdentifier) {
                return leftIdentifier < rightIdentifier ? -1 : 1;
            }
        }
    }
    return 0;
}

export function versionParts(tag) {
    return parseReleaseVersion(tag).core;
}

function parseReleaseVersion(tag) {
    const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-.]([0-9A-Za-z][0-9A-Za-z.-]*))?$/u.exec(tag);
    if (!match) {
        throw new Error(`Invalid release tag: ${tag}`);
    }
    return {
        core: [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
        ],
        prerelease: match[4]?.split('.') ?? [],
    };
}

export function contentTypeFor(filename) {
    const extension = basename(filename).toLowerCase().split('.').at(-1);
    return ({
        appimage: 'application/octet-stream',
        blockmap: 'application/octet-stream',
        deb: 'application/vnd.debian.binary-package',
        dmg: 'application/x-apple-diskimage',
        exe: 'application/vnd.microsoft.portable-executable',
        json: 'application/json',
        yml: 'text/yaml; charset=utf-8',
        zip: 'application/zip',
    })[extension] ?? 'application/octet-stream';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [
        artifactDirectory,
        releaseTag,
        mode,
    ] = process.argv.slice(2);
    if (mode && mode !== '--stage') {
        throw new Error(`Unknown mirror publish mode: ${mode}`);
    }
    await publishReleaseMirror({
        artifactDirectory,
        releaseTag,
        publishChannel: mode !== '--stage',
    });
}
