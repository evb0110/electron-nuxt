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
import {
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';

const RELEASE_PREFIX = 'evb-viewer/releases/';
const CHANNEL_KEY = 'evb-viewer/channels/stable.json';
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const RETAINED_RELEASE_COUNT = 4;

const [
    artifactDirectory,
    releaseTag,
] = process.argv.slice(2);

if (!artifactDirectory || !releaseTag) {
    throw new Error('Usage: publish-release-mirror.mjs <artifact-directory> <release-tag>');
}
if (!RELEASE_TAG_PATTERN.test(releaseTag)) {
    throw new Error(`Invalid release tag: ${releaseTag}`);
}

const endpoint = requireEnvironment('MIRROR_S3_ENDPOINT');
const bucket = requireEnvironment('MIRROR_S3_BUCKET');
const client = new S3Client({
    endpoint,
    region: process.env.MIRROR_S3_REGION || 'ru-central1',
    // Yandex implements the S3 API but not every optional AWS checksum mode.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
        accessKeyId: requireEnvironment('MIRROR_S3_ACCESS_KEY_ID'),
        secretAccessKey: requireEnvironment('MIRROR_S3_SECRET_KEY'),
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
    console.log(`Uploading ${name} (${fileStat.size} bytes)`);
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
        ContentType: contentTypeFor(name),
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { sha256 },
    }));
    await verifyUpload(key, fileStat.size, sha256);
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
await putJson(`${RELEASE_PREFIX}${releaseTag}/manifest.json`, manifest, 'public, max-age=31536000, immutable');

// Publish the mutable channel pointer last, after every immutable object has
// been uploaded and verified. Clients can never discover a partial release.
await putJson(CHANNEL_KEY, manifest, 'no-cache, no-store, must-revalidate');

const prunedTags = await pruneOldReleases();
console.log(`Mirror published ${releaseTag}; retained ${RETAINED_RELEASE_COUNT} releases${
    prunedTags.length ? ` and pruned ${prunedTags.join(', ')}` : ''
}`);

function requireEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

async function hashFile(filePath) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function verifyUpload(key, expectedSize, expectedSha256) {
    const result = await client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    if (result.ContentLength !== expectedSize || result.Metadata?.sha256 !== expectedSha256) {
        throw new Error(`Mirror verification failed for ${key}`);
    }
}

async function putJson(key, body, cacheControl) {
    const sha256 = createHash('sha256').update(body).digest('hex');
    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: Buffer.byteLength(body),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: cacheControl,
        Metadata: { sha256 },
    }));
    await verifyUpload(key, Buffer.byteLength(body), sha256);
}

async function pruneOldReleases() {
    const objects = await listAllReleaseObjects();
    const tags = [...new Set(objects.map(object => object.Key?.slice(RELEASE_PREFIX.length).split('/')[0]).filter(Boolean))]
        .filter(tag => RELEASE_TAG_PATTERN.test(tag))
        .sort(compareReleaseTags)
        .reverse();
    const staleTags = tags.slice(RETAINED_RELEASE_COUNT);
    const staleKeys = objects
        .map(object => object.Key)
        .filter(key => key && staleTags.some(tag => key.startsWith(`${RELEASE_PREFIX}${tag}/`)));

    for (let index = 0; index < staleKeys.length; index += 1_000) {
        const batch = staleKeys.slice(index, index + 1_000);
        await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: batch.map(Key => ({ Key })),
                Quiet: true,
            },
        }));
    }
    return staleTags;
}

async function listAllReleaseObjects() {
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

function compareReleaseTags(left, right) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    for (let index = 0; index < 3; index++) {
        const comparison = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (comparison !== 0) {
            return comparison;
        }
    }
    return left.localeCompare(right);
}

function versionParts(tag) {
    return tag.slice(1).split(/[.-]/, 3).map(part => Number.parseInt(part, 10));
}

function contentTypeFor(filename) {
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
