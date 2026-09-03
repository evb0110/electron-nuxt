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
import {isSupplementalReleaseAsset} from './policy.mjs';
import {hashFile} from './release-hash.mjs';
import {
    DRILL_TAG_PATTERN,
    RELEASE_TAG_PATTERN,
} from './releaseTag.mjs';

const RELEASE_PREFIX = 'evb-viewer/releases/';
const CHANNEL_KEY = 'evb-viewer/channels/stable.json';
const DRILL_PREFIX = 'evb-viewer/drill/';
const MIRROR_PREFIX_PATTERN = /^evb-viewer\/[a-z0-9./-]+\/$/u;
const MIRROR_CHANNEL_KEY_PATTERN = /^evb-viewer\/[a-z0-9./-]+$/u;
const RETAINED_RELEASE_COUNT = 4;

export const MIRROR_TRANSFER_TIMEOUTS = Object.freeze({
    connectionTimeout: 10_000,
    socketTimeout: 60_000,
    requestTimeout: 10 * 60_000,
});
const UPLOAD_ATTEMPTS = 3;
const TRANSIENT_TRANSFER_ERROR_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'EHOSTUNREACH',
]);

export async function publishReleaseMirror({
    artifactDirectory,
    drill = false,
    releaseTag,
    publishChannel = true,
    environment = process.env,
    client: providedClient,
    uploadRetryDelayMs = 5_000,
}) {
    if (!artifactDirectory || !releaseTag) {
        throw new Error('Usage: publish-release-mirror.mjs <artifact-directory> <release-tag>');
    }
    const mirrorPaths = resolveMirrorPaths(environment, {drill});
    const releaseTagPattern = drill ? DRILL_TAG_PATTERN : RELEASE_TAG_PATTERN;
    if (!releaseTagPattern.test(releaseTag)) {
        throw new Error(`Invalid release tag: ${releaseTag}`);
    }

    const {
        bucket,
        client,
    } = createMirrorClient(environment, providedClient);

    const releaseVersion = releaseTag.slice(1);
    const artifactNames = (await readdir(artifactDirectory))
        .filter(name => !name.startsWith('.'))
        // Supplemental channels attach after promotion and stay outside the
        // immutable core mirror. Filtering here keeps same-tag repair runs
        // byte-identical after those assets already exist on GitHub.
        .filter(name => !isSupplementalReleaseAsset(name, releaseVersion))
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
        const key = `${mirrorPaths.releasePrefix}${releaseTag}/${name}`;
        const existingState = await immutableUploadState(client, bucket, key, fileStat.size, sha256);
        if (existingState === 'match') {
            console.log(`Already verified ${name} (${fileStat.size} bytes)`);
        } else if (existingState === 'mismatch') {
            throw new Error(`Immutable mirror object mismatch for ${key}`);
        } else {
            console.log(`Uploading ${name} (${fileStat.size} bytes)`);
            await putImmutableFile(client, bucket, key, {
                filePath,
                name,
                sha256,
                size: fileStat.size,
            }, uploadRetryDelayMs);
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
        `${mirrorPaths.releasePrefix}${releaseTag}/manifest.json`,
        manifest,
        'public, max-age=31536000, immutable',
    );

    let prunedTags = [];
    if (publishChannel) {
        // Publish the mutable channel pointer last, after every immutable object
        // has been uploaded and verified. Clients cannot discover a partial release.
        const previousChannel = await readStableChannel(
            client,
            bucket,
            mirrorPaths.channelKey,
            releaseTagPattern,
        );
        let stableChannelMutationAttempted = false;
        try {
            stableChannelMutationAttempted = await publishStableChannel(
                client,
                bucket,
                manifest,
                releaseTag,
                environment,
                mirrorPaths.channelKey,
                releaseTagPattern,
            );
            prunedTags = await pruneOldReleases(
                client,
                bucket,
                releaseTag,
                mirrorPaths.releasePrefix,
                releaseTagPattern,
            );
        } catch (error) {
            if (previousChannel && (
                stableChannelMutationAttempted
                || error?.stableChannelMutationAttempted === true
            )) {
                try {
                    await restoreStableChannel(
                        client,
                        bucket,
                        previousChannel,
                        mirrorPaths.channelKey,
                        releaseTagPattern,
                    );
                } catch (rollbackError) {
                    throw new Error(
                        `Mirror publication failed and stable-channel rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
                        {cause: error},
                    );
                }
                console.error(`Mirror publication failed; stable channel rolled back to ${previousChannel.tag}.`);
            }
            throw error;
        }
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

export function resolveMirrorPaths(environment = process.env, {drill = false} = {}) {
    const releasePrefix = environment.MIRROR_RELEASE_PREFIX?.trim() || RELEASE_PREFIX;
    const channelKey = environment.MIRROR_CHANNEL_KEY?.trim() || CHANNEL_KEY;

    if (!MIRROR_PREFIX_PATTERN.test(releasePrefix)) {
        throw new Error(`Invalid mirror release prefix: ${releasePrefix}`);
    }
    if (!MIRROR_CHANNEL_KEY_PATTERN.test(channelKey)) {
        throw new Error(`Invalid mirror channel key: ${channelKey}`);
    }
    if (channelKey.split('/')[0] !== releasePrefix.split('/')[0]) {
        throw new Error('Mirror channel key must use the same top-level folder as the release prefix');
    }

    if (drill) {
        if (!releasePrefix.startsWith(DRILL_PREFIX)) {
            throw new Error('Drill mirror publication requires an evb-viewer/drill/ release prefix');
        }
        if (!channelKey.startsWith(DRILL_PREFIX)) {
            throw new Error('Drill mirror publication requires an evb-viewer/drill/ channel key');
        }
    } else if (releasePrefix !== RELEASE_PREFIX || channelKey !== CHANNEL_KEY) {
        throw new Error('Production mirror publication requires the production release prefix and channel key');
    }

    return {
        channelKey,
        releasePrefix,
    };
}

export async function cleanupMirrorPrefix({
    environment = process.env,
    prefix,
    client: providedClient,
}) {
    const cleanupPrefix = validateDrillCleanupPrefix(prefix);
    const {
        bucket,
        client,
    } = createMirrorClient(environment, providedClient);
    const objects = await listAllReleaseObjects(client, bucket, cleanupPrefix);
    const keys = objects
        .map(object => object.Key)
        .filter(key => typeof key === 'string' && key.startsWith(cleanupPrefix));

    await deleteMirrorObjects(client, bucket, keys, 'Mirror cleanup');

    console.log(`Deleted ${keys.length} drill mirror objects under ${cleanupPrefix}`);
    return {deletedKeys: keys};
}

export {hashFile};

export function createMirrorClient(environment, providedClient) {
    const endpoint = requireEnvironment(environment, 'MIRROR_S3_ENDPOINT');
    const bucket = requireEnvironment(environment, 'MIRROR_S3_BUCKET');
    return {
        bucket,
        client: providedClient ?? new S3Client({
            endpoint,
            region: environment.MIRROR_S3_REGION || 'ru-central1',
            // Yandex implements the S3 API but not every optional AWS checksum mode.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            // A single installer upload from a GitHub runner has stalled
            // silently for the whole job. Without these limits nothing aborts
            // it before GitHub's six-hour job cap, and the global release
            // concurrency group stays blocked for that long.
            requestHandler: {
                ...MIRROR_TRANSFER_TIMEOUTS,
                throwOnRequestTimeout: true,
            },
            credentials: {
                accessKeyId: requireEnvironment(environment, 'MIRROR_S3_ACCESS_KEY_ID'),
                secretAccessKey: requireEnvironment(environment, 'MIRROR_S3_SECRET_KEY'),
            },
        }),
    };
}

function validateDrillCleanupPrefix(prefix) {
    if (typeof prefix !== 'string' || !prefix.startsWith(DRILL_PREFIX) || !MIRROR_PREFIX_PATTERN.test(prefix)) {
        throw new Error(`Refusing to clean a non-drill mirror prefix: ${prefix ?? ''}`);
    }
    return prefix;
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

async function putImmutableFile(client, bucket, key, {
    filePath,
    name,
    sha256,
    size,
}, retryDelayMs) {
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
        const startedAt = Date.now();
        try {
            // The SDK cannot rewind a partially consumed body, so every
            // attempt opens its own stream.
            await putImmutableObject(client, bucket, key, new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: createReadStream(filePath),
                ContentLength: size,
                ContentType: contentTypeFor(name),
                CacheControl: 'public, max-age=31536000, immutable',
                Metadata: { sha256 },
                IfNoneMatch: '*',
            }), size, sha256);
            console.log(`Uploaded ${name} in ${elapsedSeconds(startedAt)}s`);
            return;
        } catch (error) {
            if (attempt === UPLOAD_ATTEMPTS || !isTransientTransferError(error)) {
                throw error;
            }
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(
                `Upload of ${name} failed after ${elapsedSeconds(startedAt)}s (${reason}); `
                + `retrying (${attempt + 1}/${UPLOAD_ATTEMPTS}).`,
            );
            await delay(retryDelayMs * attempt);
        }
    }
}

function elapsedSeconds(startedAt) {
    return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function isTransientTransferError(error) {
    const status = error?.$metadata?.httpStatusCode;
    return error?.name === 'TimeoutError'
        || TRANSIENT_TRANSFER_ERROR_CODES.has(error?.code)
        || (typeof status === 'number' && status >= 500);
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

async function publishStableChannel(
    client,
    bucket,
    body,
    releaseTag,
    environment,
    channelKey,
    releaseTagPattern,
) {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const size = Buffer.byteLength(body);
    let stableChannelMutationAttempted = false;
    const markStableChannelMutation = (error) => {
        if (!stableChannelMutationAttempted) {
            return error;
        }
        if (error && typeof error === 'object') {
            error.stableChannelMutationAttempted = true;
            return error;
        }
        const wrapped = new Error(String(error), {cause: error});
        wrapped.stableChannelMutationAttempted = true;
        return wrapped;
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const current = await readStableChannel(
            client,
            bucket,
            channelKey,
            releaseTagPattern,
        );
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
            return false;
        }
        if (current && !current.etag) {
            throw new Error('Stable mirror object response has no ETag; refusing an unguarded update');
        }
        try {
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: channelKey,
                Body: body,
                ContentLength: size,
                ContentType: 'application/json; charset=utf-8',
                CacheControl: 'no-cache, no-store, must-revalidate',
                Metadata: { sha256 },
                ...(current
                    ? {IfMatch: current.etag}
                    : {IfNoneMatch: '*'}),
            }));
            // The pointer may have changed even if verification fails. Keep
            // the outer transaction informed so it can restore the old value.
            stableChannelMutationAttempted = true;
            await verifyUpload(client, bucket, channelKey, size, sha256);
            return true;
        } catch (error) {
            if (!isConditionalWriteConflict(error)) {
                throw markStableChannelMutation(error);
            }
            if (attempt === 5) {
                throw markStableChannelMutation(new Error(
                    'Stable mirror channel changed repeatedly during publication',
                    {cause: error},
                ));
            }
            await delay(25 * attempt);
        }
    }
}

async function readStableChannel(client, bucket, channelKey, releaseTagPattern) {
    let response;
    try {
        response = await client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: channelKey,
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
    if (typeof tag !== 'string' || !releaseTagPattern.test(tag)) {
        throw new Error('Stable mirror object has an invalid release tag');
    }
    return {
        body: raw,
        etag: response.ETag,
        sha256: createHash('sha256').update(raw).digest('hex'),
        size: Buffer.byteLength(raw),
        tag,
    };
}

async function restoreStableChannel(client, bucket, previousChannel, channelKey, releaseTagPattern) {
    const current = await readStableChannel(
        client,
        bucket,
        channelKey,
        releaseTagPattern,
    );
    if (current?.sha256 === previousChannel.sha256) {
        return;
    }
    if (!current?.etag) {
        throw new Error('Stable mirror rollback found no guarded current channel object');
    }

    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: channelKey,
        Body: previousChannel.body,
        ContentLength: previousChannel.size,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-cache, no-store, must-revalidate',
        Metadata: {sha256: previousChannel.sha256},
        IfMatch: current.etag,
    }));
    await verifyUpload(client, bucket, channelKey, previousChannel.size, previousChannel.sha256);
}

async function pruneOldReleases(client, bucket, protectedTag, releasePrefix, releaseTagPattern) {
    const objects = await listAllReleaseObjects(client, bucket, releasePrefix);
    const tags = [...new Set(objects.map(object => object.Key?.slice(releasePrefix.length).split('/')[0]).filter(Boolean))]
        .filter(tag => releaseTagPattern.test(tag))
        .sort(compareReleaseTags)
        .reverse();
    const retainedTags = new Set(tags.slice(0, RETAINED_RELEASE_COUNT));
    retainedTags.add(protectedTag);
    const staleTags = tags.filter(tag => !retainedTags.has(tag));
    const staleKeys = objects
        .map(object => object.Key)
        .filter(key => key && staleTags.some(tag => key.startsWith(`${releasePrefix}${tag}/`)));

    await deleteMirrorObjects(client, bucket, staleKeys, 'Mirror pruning');
    return staleTags;
}

async function deleteMirrorObjects(client, bucket, keys, label) {
    for (let index = 0; index < keys.length; index += 1_000) {
        const batch = keys.slice(index, index + 1_000);
        const result = await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: batch.map(Key => ({Key})),
                Quiet: true,
            },
        }));
        if ((result.Errors ?? []).length > 0) {
            throw new Error(`${label} failed for ${result.Errors.map(error => error.Key ?? 'unknown').join(', ')}`);
        }
    }
}

async function listAllReleaseObjects(client, bucket, releasePrefix) {
    const objects = [];
    let continuationToken;
    do {
        const page = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: releasePrefix,
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
    const args = process.argv.slice(2);
    if (args[0] === 'cleanup') {
        if (args.length !== 2) {
            throw new Error('Usage: publish-release-mirror.mjs cleanup <evb-viewer/drill/.../>');
        }
        await cleanupMirrorPrefix({prefix: args[1]});
    } else {
        const [
            artifactDirectory,
            releaseTag,
            ...modes
        ] = args;
        const allowedModes = new Set([
            '--drill',
            '--stage',
        ]);
        if (modes.some(mode => !allowedModes.has(mode))) {
            throw new Error(`Unknown mirror publish mode: ${modes.find(mode => !allowedModes.has(mode))}`);
        }
        await publishReleaseMirror({
            artifactDirectory,
            drill: modes.includes('--drill'),
            releaseTag,
            publishChannel: !modes.includes('--stage'),
        });
    }
}
