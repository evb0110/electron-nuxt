import {execFile} from 'node:child_process';
import {
    createHash,
    createHmac,
    randomUUID,
} from 'node:crypto';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SentryCli} from '@sentry/cli';
import {
    assertSameSentryBuildIdentity,
    assertSentryBuildIdentity,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';
import {assertSentryPrivateManifestParity} from './build-receipt.mjs';
import {getPrivateSourcemapManifestPath} from './stage-private-sourcemaps.mjs';

const execFileAsync = promisify(execFile);
const SENTRY_EU_API_ORIGIN = 'https://de.sentry.io/';
export const UPLOAD_RECEIPT_SCHEMA_VERSION = 3;
const SAFE_CONFIGURATION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UPLOAD_EXTENSIONS = [
    'js',
    'cjs',
    'mjs',
    'map',
    'jsbundle',
    'bundle',
    'ts',
    'tsx',
    'vue',
    'json',
];

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function destinationFingerprint({
    organization,
    project,
    token,
}) {
    return createHmac('sha256', token)
        .update(organization)
        .update('\0')
        .update(project)
        .digest('hex');
}

export function assertSentryUploadReceipt(receipt, identity) {
    const expectedIdentity = assertSentryBuildIdentity(identity);
    if (
        !receipt
        || typeof receipt !== 'object'
        || receipt.schemaVersion !== UPLOAD_RECEIPT_SCHEMA_VERSION
        || !Number.isSafeInteger(receipt.bundleCount)
        || receipt.bundleCount < 1
        || typeof receipt.destinationFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/u.test(receipt.destinationFingerprint)
        || typeof receipt.manifestSha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(receipt.manifestSha256)
    ) {
        throw new Error('Private Sentry upload did not return a valid receipt');
    }
    assertSameSentryBuildIdentity(expectedIdentity, receipt.identity);
    return receipt;
}

function requiredPrivateConfiguration(environment, key, label) {
    const value = environment[key];
    if (typeof value !== 'string' || !SAFE_CONFIGURATION_VALUE.test(value)) {
        throw new Error(`Missing or invalid private Sentry ${label} configuration`);
    }
    return value;
}

function requiredUploadToken(environment) {
    const value = environment.SENTRY_AUTH_TOKEN;
    if (typeof value !== 'string' || value.trim().length === 0 || /[\r\n]/u.test(value)) {
        throw new Error('Missing or invalid private Sentry upload credential');
    }
    return value;
}

function resolveInside(root, relativePath, label) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new Error(`Invalid ${label} path in private source-map manifest`);
    }
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new Error(`Unsafe ${label} path in private source-map manifest`);
    }
    return resolved;
}

async function copyIntoUploadRoot(sourcePath, uploadRoot, relativePath, label) {
    const destination = resolveInside(uploadRoot, relativePath, label);
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(sourcePath, destination);
}

function uploadRelativePath(target, relativePath) {
    if (target === 'web' && relativePath.startsWith('.vercel/')) {
        return `vercel/${relativePath.slice('.vercel/'.length)}`;
    }
    return relativePath;
}

function cliUploadRoots(identity, uploadRoot, manifest) {
    if (identity.target !== 'web') {
        return [uploadRoot];
    }
    const roots = new Set();
    for (const bundle of manifest.bundles) {
        if (bundle.bundle.startsWith('.vercel/output/static/')) {
            roots.add(path.join(uploadRoot, 'vercel/output/static'));
        } else if (bundle.bundle.startsWith('.vercel/output/functions/')) {
            roots.add(path.join(uploadRoot, 'vercel/output/functions'));
        } else {
            throw new Error(`Unsupported web source-map output path: ${bundle.bundle}`);
        }
    }
    return [...roots].sort((left, right) => left.localeCompare(right, 'en'));
}

function cliUploadUrlPrefix(identity, uploadRoot, cliRoot) {
    if (
        identity.target === 'web'
        && cliRoot === path.join(uploadRoot, 'vercel/output/static')
    ) {
        return '~/';
    }
    return null;
}

async function prepareUploadTree({
    identity,
    projectRoot,
    stageRoot,
    uploadRoot,
    manifest,
}) {
    for (const bundle of manifest.bundles) {
        await copyIntoUploadRoot(
            resolveInside(projectRoot, bundle.bundle, 'public bundle'),
            uploadRoot,
            uploadRelativePath(identity.target, bundle.bundle),
            'upload bundle',
        );
        await copyIntoUploadRoot(
            resolveInside(stageRoot, bundle.stagedMapPath, 'staged map'),
            uploadRoot,
            uploadRelativePath(identity.target, bundle.map),
            'upload map',
        );
    }
    for (const source of manifest.sources) {
        await copyIntoUploadRoot(
            resolveInside(stageRoot, source.stagedPath, 'staged source'),
            uploadRoot,
            source.path,
            'upload source',
        );
    }
}

function privateCliEnvironment(token) {
    const environment = {
        CI: '1',
        NO_COLOR: '1',
        SENTRY_AUTH_TOKEN: token,
        SENTRY_DISABLE_UPDATE_CHECK: '1',
        SENTRY_LOG_LEVEL: 'error',
        SENTRY_URL: SENTRY_EU_API_ORIGIN,
    };
    if (process.platform === 'win32' && process.env.SystemRoot) {
        environment.SystemRoot = process.env.SystemRoot;
    }
    return environment;
}

async function defaultRunCli(args, {token}) {
    await execFileAsync(SentryCli.getPath(), args, {
        env: privateCliEnvironment(token),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
}

function projectEnvironmentKey(target) {
    return target === 'desktop'
        ? 'SENTRY_DESKTOP_PROJECT'
        : 'SENTRY_WEB_PROJECT';
}

function readBuildIdentity(environment) {
    return assertSentryBuildIdentity({
        target: environment.EVB_SENTRY_TARGET,
        release: environment.EVB_SENTRY_RELEASE,
        dist: environment.EVB_SENTRY_DIST,
        environment: environment.EVB_SENTRY_ENVIRONMENT,
    });
}

async function readExistingUploadReceipt(receiptPath, expected) {
    let receipt;
    try {
        receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw new Error('Invalid private Sentry upload receipt');
    }
    if (Number.isSafeInteger(receipt?.schemaVersion)
        && receipt.schemaVersion < UPLOAD_RECEIPT_SCHEMA_VERSION) {
        return null;
    }
    if (
        receipt?.schemaVersion !== UPLOAD_RECEIPT_SCHEMA_VERSION
        || receipt.bundleCount !== expected.bundleCount
        || receipt.destinationFingerprint !== expected.destinationFingerprint
        || receipt.manifestSha256 !== expected.manifestSha256
    ) {
        throw new Error('Private Sentry upload receipt does not match the build manifest');
    }
    assertSameSentryBuildIdentity(expected.identity, receipt.identity);
    return receipt;
}

/**
 * Uploads the exact injected bundles and private maps described by one build
 * manifest. The temporary upload tree is removed on both success and failure.
 * No credential or private account identifier is written to disk or returned.
 *
 * @param {{
 *   identity: import('@contracts/diagnostics/releaseIdentity.js').SentryBuildIdentity,
 *   projectRoot?: string,
 *   environment?: NodeJS.ProcessEnv,
 *   runCli?: (args: string[], options: {token: string}) => Promise<void>,
 * }} options
 */
export async function uploadSentrySourcemaps({
    identity,
    projectRoot = process.cwd(),
    environment = process.env,
    runCli = defaultRunCli,
} = {}) {
    const normalizedIdentity = assertSentryBuildIdentity(identity);
    const root = path.resolve(projectRoot);
    const manifestPath = getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity: normalizedIdentity,
    });
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assertSameSentryBuildIdentity(normalizedIdentity, manifest.identity);
    assertSentryPrivateManifestParity({
        identity: normalizedIdentity,
        projectRoot: root,
    });

    const organization = requiredPrivateConfiguration(
        environment,
        'SENTRY_ORG',
        'organization',
    );
    const project = requiredPrivateConfiguration(
        environment,
        projectEnvironmentKey(normalizedIdentity.target),
        'project',
    );
    const token = requiredUploadToken(environment);
    const stageRoot = path.dirname(manifestPath);
    const receiptPath = path.join(stageRoot, 'upload-receipt.json');
    const expectedReceipt = {
        bundleCount: manifest.bundles.length,
        destinationFingerprint: destinationFingerprint({
            organization,
            project,
            token,
        }),
        identity: normalizedIdentity,
        manifestSha256: sha256(manifestBytes),
        schemaVersion: UPLOAD_RECEIPT_SCHEMA_VERSION,
    };
    const existingReceipt = await readExistingUploadReceipt(receiptPath, expectedReceipt);
    if (existingReceipt) {
        process.stdout.write(
            `Private source-map upload already recorded for ${normalizedIdentity.release}, `
            + `${normalizedIdentity.dist}.\n`,
        );
        return assertSentryUploadReceipt(existingReceipt, normalizedIdentity);
    }
    const uploadRoot = await mkdtemp(path.join(stageRoot, '.upload-'));
    try {
        await prepareUploadTree({
            identity: normalizedIdentity,
            projectRoot: root,
            stageRoot,
            uploadRoot,
            manifest,
        });
        try {
            for (const cliRoot of cliUploadRoots(normalizedIdentity, uploadRoot, manifest)) {
                const urlPrefix = cliUploadUrlPrefix(
                    normalizedIdentity,
                    uploadRoot,
                    cliRoot,
                );
                await runCli([
                    'sourcemaps',
                    'upload',
                    '--org',
                    organization,
                    '--project',
                    project,
                    '--release',
                    normalizedIdentity.release,
                    '--dist',
                    normalizedIdentity.dist,
                    '--validate',
                    '--strict',
                    '--wait',
                    '--quiet',
                    ...UPLOAD_EXTENSIONS.flatMap(extension => [
                        '--ext',
                        extension,
                    ]),
                    ...(urlPrefix === null ? [] : [
                        '--url-prefix',
                        urlPrefix,
                    ]),
                    cliRoot,
                ], {token});
            }
        } catch {
            throw new Error('Private Sentry source-map upload failed');
        }
    } finally {
        await rm(uploadRoot, {
            recursive: true,
            force: true,
        });
    }

    const temporaryReceiptPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
        temporaryReceiptPath,
        `${JSON.stringify(expectedReceipt, null, 2)}\n`,
        {
            flag: 'wx',
            mode: 0o600,
        },
    );
    await rename(temporaryReceiptPath, receiptPath);
    process.stdout.write(
        `Uploaded ${expectedReceipt.bundleCount} private source-map bundle(s) for `
        + `${normalizedIdentity.release}, ${normalizedIdentity.dist}.\n`,
    );
    return assertSentryUploadReceipt(expectedReceipt, normalizedIdentity);
}

async function main() {
    await uploadSentrySourcemaps({identity: readBuildIdentity(process.env)});
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : 'Source-map upload failed'}\n`);
        process.exitCode = 1;
    });
}
