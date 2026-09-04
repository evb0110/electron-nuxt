import {
    copyFile,
    link,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
import {SentryCli} from '@sentry/cli';
import { WORKER_BUNDLES } from '../../packages/electron-worker-bundles/electronWorkerBundles.js';
import {
    assertSameSentryBuildIdentity,
    assertSentryBuildIdentity,
    sentryBuildIdentityKey,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';

export const PRIVATE_SOURCEMAP_STAGE_ROOT = '.tmp/private-sourcemaps';
export const SENTRY_BUILD_IDENTITY_LOCK_PATH = '.tmp/sentry-build-identity.json';
export const PRIVATE_SOURCEMAP_MANIFEST_SCHEMA_VERSION = 1;

const DEFAULT_OUTPUT_ROOTS = [
    'dist-electron',
    'nuxt-output',
    '.vercel/output',
    '.output',
];
const JAVASCRIPT_EXTENSIONS = new Set([
    '.cjs',
    '.js',
    '.mjs',
]);
const MAX_GENERATED_MAPLESS_BROWSER_BUNDLE_BYTES = 2 * 1024;
const NUXT_CLIENT_MANIFEST_RELATIVE_PATHS = [
    '.nuxt/dist/server/client.manifest.mjs',
    'node_modules/.cache/nuxt/.nuxt/dist/server/client.manifest.mjs',
];
const PDFJS_WORKER_FACADE_FILE_PATTERN = /^pdf-[A-Za-z0-9_-]{8}\.js$/u;
const PDFJS_WORKER_IMPORT_PATTERN = /from["']\.\/pdf-[A-Za-z0-9_-]{8}\.js["']/u;
const ELECTRON_UTILITY_BUNDLE_IDS = new Set([
    'pdf-conformance',
    'pdf-print-layout',
    'document-save-utility',
]);
const WORKER_BY_FILE_NAME = new Map(
    WORKER_BUNDLES.map(bundle => [
        bundle.fileName,
        bundle,
    ]),
);
const execFileAsync = promisify(execFile);

function slashPath(value) {
    return value.split(path.sep).join('/');
}

function compareStrings(left, right) {
    return left.localeCompare(right, 'en');
}

function encodePathSegment(value) {
    return encodeURIComponent(value);
}

function stageDirectory(projectRoot, identity) {
    return path.join(
        projectRoot,
        PRIVATE_SOURCEMAP_STAGE_ROOT,
        encodePathSegment(identity.target),
        encodePathSegment(identity.release),
        encodePathSegment(identity.dist),
        encodePathSegment(identity.environment),
    );
}

function stageManifestPath(projectRoot, identity) {
    return path.join(stageDirectory(projectRoot, identity), 'manifest.json');
}

function identityLockPath(projectRoot) {
    return path.join(projectRoot, SENTRY_BUILD_IDENTITY_LOCK_PATH);
}

function normalizeOutputRoot(projectRoot, outputRoot) {
    if (typeof outputRoot !== 'string' || outputRoot.length === 0) {
        throw new TypeError('Source-map output roots must be non-empty paths');
    }
    const relativeRoot = path.relative(projectRoot, path.resolve(projectRoot, outputRoot));
    if (
        !relativeRoot
        || relativeRoot === '..'
        || relativeRoot.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeRoot)
    ) {
        throw new Error(`Refusing to stage source maps outside the project: ${outputRoot}`);
    }
    return slashPath(relativeRoot);
}

function relativeProjectPath(projectRoot, filePath) {
    const relative = slashPath(path.relative(projectRoot, filePath));
    if (
        !relative
        || relative === '..'
        || relative.startsWith('../')
        || path.isAbsolute(relative)
    ) {
        return null;
    }
    return relative;
}

async function fileExists(filePath) {
    try {
        return (await stat(filePath)).isFile();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function directoryExists(dirPath) {
    try {
        return (await stat(dirPath)).isDirectory();
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function collectFiles(rootPath) {
    const files = [];
    const visit = async (currentPath, relativePrefix = '') => {
        let entries;
        try {
            entries = await readdir(currentPath, {withFileTypes: true});
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return;
            }
            throw error;
        }
        entries.sort((left, right) => compareStrings(left.name, right.name));
        for (const entry of entries) {
            if (entry.name === 'node_modules' && entry.isDirectory()) {
                continue;
            }
            const relativePath = relativePrefix
                ? path.join(relativePrefix, entry.name)
                : entry.name;
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath, relativePath);
            } else if (entry.isFile()) {
                files.push({
                    absolutePath: entryPath,
                    relativePath: slashPath(relativePath),
                });
            }
        }
    };
    await visit(rootPath);
    return files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

function isJavaScriptBundle(relativePath) {
    const extension = path.extname(relativePath);
    return JAVASCRIPT_EXTENSIONS.has(extension)
        && !relativePath.endsWith('.meta.json');
}

function classifyBundle(outputRoot, relativePath, {
    includePreload = false,
    includeNitro = true,
} = {}) {
    const normalizedRoot = slashPath(outputRoot);
    const normalizedPath = slashPath(relativePath);
    const fileName = path.posix.basename(normalizedPath);

    if (normalizedRoot === 'dist-electron') {
        if (fileName === 'pdf.worker.mjs') {
            return null;
        }
        if (fileName === 'main.js' || /^main-chunk-/u.test(fileName)) {
            return 'electron-main';
        }
        if (fileName === 'preload.cjs') {
            return includePreload ? 'electron-preload-owned-seam' : null;
        }
        const worker = WORKER_BY_FILE_NAME.get(fileName);
        if (worker) {
            return ELECTRON_UTILITY_BUNDLE_IDS.has(worker.id)
                ? 'electron-utility-parent'
                : 'electron-worker-parent';
        }
        return null;
    }

    if (
        normalizedPath.startsWith('public/_nuxt/')
        || normalizedPath.startsWith('static/_nuxt/')
        || normalizedPath.includes('/_nuxt/')
    ) {
        return /worker/iu.test(fileName)
            ? 'browser-worker-parent'
            : 'browser-renderer';
    }

    if (
        normalizedPath.startsWith('server/')
        || normalizedPath.startsWith('functions/')
        || normalizedPath.includes('/functions/')
    ) {
        return includeNitro ? 'nitro-server' : null;
    }

    return null;
}

function mapPathForBundle(bundlePath) {
    return `${bundlePath}.map`;
}

function isVirtualSource(source) {
    return source.startsWith('\0')
        || source.startsWith('virtual:')
        || /(?:^|\/)virtual:[^/]+/u.test(source)
        || source.startsWith('data:')
        || source.startsWith('http://')
        || source.startsWith('https://')
        || source.startsWith('webpack:')
        || source.startsWith('vite:')
        || /^<[^>\r\n]+>$/u.test(source);
}

function privateProjectSource(relativePath) {
    return relativePath === null
        || relativePath.split('/').includes('node_modules')
        ? null
        : relativePath;
}

function resolveMapSource(projectRoot, mapPath, sourceRoot, source) {
    if (typeof source !== 'string' || source.length === 0 || isVirtualSource(source)) {
        return null;
    }

    let sourcePath = source;
    if (typeof sourceRoot === 'string' && sourceRoot.length > 0) {
        try {
            sourcePath = new URL(source, sourceRoot).href;
        } catch {
            sourcePath = path.posix.join(sourceRoot, source);
        }
    }
    if (sourcePath.startsWith('file://')) {
        try {
            sourcePath = decodeURIComponent(new URL(sourcePath).pathname);
        } catch {
            return null;
        }
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(sourcePath)) {
        sourcePath = sourcePath.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u, '').replace(/^\/+/, '');
        return privateProjectSource(
            relativeProjectPath(projectRoot, path.resolve(projectRoot, sourcePath)),
        );
    }

    const absolutePath = path.isAbsolute(sourcePath)
        ? path.resolve(sourcePath)
        : path.resolve(path.dirname(mapPath), sourcePath);
    return privateProjectSource(relativeProjectPath(projectRoot, absolutePath));
}

function assertSourceMapPayload(payload, mapRelativePath) {
    if (
        !payload
        || typeof payload !== 'object'
        || payload.version !== 3
        || !Array.isArray(payload.sources)
    ) {
        throw new Error(`Invalid source map for reportable bundle: ${mapRelativePath}`);
    }
    if (
        payload.sourcesContent !== undefined
        && payload.sourcesContent !== false
        && (!Array.isArray(payload.sourcesContent)
            || payload.sourcesContent.some(content => content !== null))
    ) {
        throw new Error(`Source map embeds source content: ${mapRelativePath}`);
    }
}

async function injectDebugIds(bundlePaths) {
    if (bundlePaths.length === 0) {
        return;
    }
    await execFileAsync(SentryCli.getPath(), [
        'sourcemaps',
        'inject',
        '--quiet',
        ...bundlePaths,
    ], {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
}

async function sha256(filePath) {
    const bytes = await readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
}

async function readExistingManifest(manifestPath, identity) {
    if (!(await fileExists(manifestPath))) {
        return null;
    }
    let manifest;
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
        throw new Error(`Unreadable private source-map manifest: ${manifestPath}`, {cause: error});
    }
    if (
        manifest?.schemaVersion !== PRIVATE_SOURCEMAP_MANIFEST_SCHEMA_VERSION
        || !manifest.identity
        || typeof manifest.identity !== 'object'
    ) {
        throw new Error(`Invalid private source-map manifest: ${manifestPath}`);
    }
    assertSameSentryBuildIdentity(identity, manifest.identity);
    return manifest;
}

async function lockBuildIdentity(projectRoot, identity) {
    const lockPath = identityLockPath(projectRoot);
    await mkdir(path.dirname(lockPath), {recursive: true});

    // Write the complete payload first, then publish it with an atomic hard
    // link. A competing build can observe either no lock or the complete lock,
    // never a partially written identity.
    const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`);
    try {
        await link(temporaryPath, lockPath);
    } catch (error) {
        if (error?.code !== 'EEXIST') {
            throw error;
        }
        await assertLockedBuildIdentity(lockPath, identity);
    } finally {
        await rm(temporaryPath, {force: true});
    }
    return lockPath;
}

async function assertLockedBuildIdentity(lockPath, identity) {
    let existing;
    try {
        existing = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch (error) {
        throw new Error(`Unreadable Sentry build identity lock: ${lockPath}`, {cause: error});
    }
    assertSameSentryBuildIdentity(identity, existing);
}

async function resetCompletedIdentityLockOnConflict(projectRoot, identity) {
    const lockPath = identityLockPath(projectRoot);
    if (!(await fileExists(lockPath))) {
        return;
    }
    let existingIdentity;
    try {
        existingIdentity = assertSentryBuildIdentity(JSON.parse(await readFile(lockPath, 'utf8')));
    } catch {
        return;
    }
    try {
        assertSameSentryBuildIdentity(identity, existingIdentity);
        return;
    } catch {
        // A completed prior build may release its persistent identity lock.
    }
    if (!(await fileExists(stageManifestPath(projectRoot, existingIdentity)))) {
        return;
    }
    const currentLock = await readFile(lockPath, 'utf8');
    if (currentLock !== `${JSON.stringify(existingIdentity, null, 2)}\n`) {
        return;
    }
    await rm(lockPath, {force: true});
}

function manifestBundleMap(manifest) {
    return new Map((manifest?.bundles ?? []).map(bundle => [
        bundle.bundle,
        bundle,
    ]));
}

function manifestUnmappedGeneratedBundleMap(manifest) {
    return new Map((manifest?.unmappedGeneratedBundles ?? []).map(bundle => [
        bundle.bundle,
        bundle,
    ]));
}

function decodeGeneratedManifestString(encoded) {
    try {
        return JSON.parse(`"${encoded}"`);
    } catch {
        return null;
    }
}

function normalizeNuxtAssetPath(value) {
    const slashed = value.replaceAll('\\', '/').replace(/^\/+/, '');
    const withoutNuxtPrefix = slashed.startsWith('_nuxt/')
        ? slashed.slice('_nuxt/'.length)
        : slashed;
    const normalized = path.posix.normalize(withoutNuxtPrefix);
    if (
        !normalized
        || normalized === '.'
        || normalized === '..'
        || normalized.startsWith('../')
        || path.posix.isAbsolute(normalized)
    ) {
        return null;
    }
    return normalized;
}

function relativeNuxtAssetPath(relativeBundlePath) {
    const marker = '/_nuxt/';
    const markerIndex = relativeBundlePath.indexOf(marker);
    return markerIndex === -1
        ? null
        : normalizeNuxtAssetPath(relativeBundlePath.slice(markerIndex + marker.length));
}

async function readNuxtGeneratedBrowserBundleNames(projectRoot) {
    const configuredBuildDir = process.env.EVB_NUXT_BUILD_DIR?.trim();
    const manifestPaths = [
        ...(configuredBuildDir
            ? [path.join(configuredBuildDir, 'dist/server/client.manifest.mjs')]
            : []),
        ...NUXT_CLIENT_MANIFEST_RELATIVE_PATHS,
    ];
    for (const manifestPath of manifestPaths) {
        const absoluteManifestPath = path.resolve(projectRoot, manifestPath);
        if (!(await fileExists(absoluteManifestPath))) {
            continue;
        }
        const manifestText = await readFile(absoluteManifestPath, 'utf8');
        const bundleNames = new Set();
        for (const match of manifestText.matchAll(/(?:"file"|\bfile):"((?:\\.|[^"\\])+)"/gu)) {
            const decoded = decodeGeneratedManifestString(match[1]);
            const normalized = typeof decoded === 'string'
                ? normalizeNuxtAssetPath(decoded)
                : null;
            if (normalized && isJavaScriptBundle(normalized)) {
                bundleNames.add(normalized);
            }
        }
        if (bundleNames.size === 0) {
            throw new Error(`Nuxt client manifest has no JavaScript bundles: ${manifestPath}`);
        }
        return bundleNames;
    }
    return new Set();
}

function identifyGeneratedMaplessBrowserBundle(relativeAssetPath, bundleText, generatedBundleNames) {
    if (bundleText.includes('sourceMappingURL')) {
        return null;
    }
    if (generatedBundleNames.has(relativeAssetPath)) {
        return 'nuxt-client-manifest';
    }
    if (
        PDFJS_WORKER_FACADE_FILE_PATTERN.test(relativeAssetPath)
        && PDFJS_WORKER_IMPORT_PATTERN.test(bundleText)
        && bundleText.includes('export{')
    ) {
        return 'pdfjs-worker-facade-policy';
    }
    return null;
}

async function stageBundle({
    projectRoot,
    outputRoot,
    bundle,
    role,
    mapPath,
    stageRoot,
}) {
    const mapRelativePath = slashPath(path.join(outputRoot, mapPath));
    const bundleRelativePath = slashPath(path.join(outputRoot, bundle));
    const mapPayload = JSON.parse(await readFile(path.join(projectRoot, mapRelativePath), 'utf8'));
    assertSourceMapPayload(mapPayload, mapRelativePath);

    const stagedMapRelativePath = slashPath(path.join('maps', mapRelativePath));
    const stagedMapPath = path.join(stageRoot, stagedMapRelativePath);
    await mkdir(path.dirname(stagedMapPath), {recursive: true});
    await copyFile(path.join(projectRoot, mapRelativePath), stagedMapPath);

    const sourcePaths = [];
    const sourceFiles = [];
    const uniqueSources = new Set();
    for (const source of mapPayload.sources) {
        let sourceRelativePath = resolveMapSource(
            projectRoot,
            path.join(projectRoot, mapRelativePath),
            mapPayload.sourceRoot,
            source,
        );
        if (
            sourceRelativePath
            && !(await fileExists(path.join(projectRoot, sourceRelativePath)))
            && typeof source === 'string'
        ) {
            const rootRelativeSource = source.replace(/^(?:\.\.\/)+/u, '').replace(/^\.\//u, '');
            const rootRelativePath = privateProjectSource(relativeProjectPath(
                projectRoot,
                path.resolve(projectRoot, rootRelativeSource),
            ));
            if (rootRelativePath && await fileExists(path.join(projectRoot, rootRelativePath))) {
                sourceRelativePath = rootRelativePath;
            }
        }
        if (!sourceRelativePath || uniqueSources.has(sourceRelativePath)) {
            continue;
        }
        uniqueSources.add(sourceRelativePath);
        const sourceAbsolutePath = path.join(projectRoot, sourceRelativePath);
        if (!(await fileExists(sourceAbsolutePath))) {
            throw new Error(
                `Private source-map staging could not find ${source} for ${mapRelativePath}`,
            );
        }
        const stagedSourceRelativePath = slashPath(path.join('sources', sourceRelativePath));
        const stagedSourcePath = path.join(stageRoot, stagedSourceRelativePath);
        await mkdir(path.dirname(stagedSourcePath), {recursive: true});
        await copyFile(sourceAbsolutePath, stagedSourcePath);
        const sourceStat = await stat(sourceAbsolutePath);
        const sourceEntry = {
            bytes: sourceStat.size,
            path: sourceRelativePath,
            sha256: await sha256(sourceAbsolutePath),
            stagedPath: stagedSourceRelativePath,
        };
        sourcePaths.push(sourceRelativePath);
        sourceFiles.push(sourceEntry);
    }

    const mapStat = await stat(path.join(projectRoot, mapRelativePath));
    const bundleStat = await stat(path.join(projectRoot, bundleRelativePath));
    return {
        bundle: bundleRelativePath,
        bundleBytes: bundleStat.size,
        bundleSha256: await sha256(path.join(projectRoot, bundleRelativePath)),
        map: mapRelativePath,
        mapBytes: mapStat.size,
        mapSha256: await sha256(path.join(projectRoot, mapRelativePath)),
        role,
        sourceFiles: sourceFiles.sort((left, right) => compareStrings(left.path, right.path)),
        sources: sourcePaths.sort(compareStrings),
        stagedMapPath: stagedMapRelativePath,
    };
}

async function describeUnmappedGeneratedBrowserBundle({
    candidate,
    generatedBundleNames,
    outputRoot,
    projectRoot,
}) {
    if (
        candidate.role !== 'browser-renderer'
        || !(
            candidate.relativePath.startsWith('public/_nuxt/')
            || candidate.relativePath.startsWith('static/_nuxt/')
        )
    ) {
        return null;
    }
    const bundlePath = path.join(projectRoot, outputRoot, candidate.relativePath);
    const bundleStat = await stat(bundlePath);
    if (bundleStat.size > MAX_GENERATED_MAPLESS_BROWSER_BUNDLE_BYTES) {
        return null;
    }
    const bundleText = await readFile(bundlePath, 'utf8');
    const relativeAssetPath = relativeNuxtAssetPath(candidate.relativePath);
    if (!relativeAssetPath) {
        return null;
    }
    const producer = identifyGeneratedMaplessBrowserBundle(
        relativeAssetPath,
        bundleText,
        generatedBundleNames,
    );
    if (!producer) {
        return null;
    }
    const bundle = slashPath(path.join(outputRoot, candidate.relativePath));
    return {
        bundle,
        bundleBytes: bundleStat.size,
        bundleSha256: await sha256(bundlePath),
        producer,
        role: 'browser-generated-mapless',
    };
}

async function removeMaps(outputRootPath) {
    const files = await collectFiles(outputRootPath);
    const mapFiles = files.filter(file => file.relativePath.endsWith('.map'));
    for (const mapFile of mapFiles) {
        await rm(mapFile.absolutePath, {force: true});
    }
    return mapFiles.map(file => file.relativePath).sort(compareStrings);
}

function collectSourceEntries(bundles) {
    const sources = new Map();
    for (const bundle of bundles) {
        for (const source of bundle.sourceFiles) {
            const old = sources.get(source.path);
            if (old && JSON.stringify(old) !== JSON.stringify(source)) {
                throw new Error(`Conflicting private source contents for ${source.path}`);
            }
            sources.set(source.path, source);
        }
    }
    return [...sources.values()].sort((left, right) => compareStrings(left.path, right.path));
}

async function writeManifest(manifestPath, manifest) {
    await mkdir(path.dirname(manifestPath), {recursive: true});
    const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    try {
        await rename(temporaryPath, manifestPath);
    } finally {
        await rm(temporaryPath, {force: true});
    }
}

/**
 * Stages reportable source maps and their project-local sources, then removes
 * every map from the supplied public output roots. The manifest contains no
 * credentials, URLs, timestamps, or source contents, so a later uploader can
 * consume it without rebuilding or inspecting the public output.
 *
 * @param {{
 *   projectRoot?: string,
 *   identity: import('@contracts/diagnostics/releaseIdentity.js').SentryBuildIdentity,
 *   outputRoots?: string[],
 *   reset?: boolean,
 *   resetCompletedIdentityLock?: boolean,
 *   removePublicOutputMaps?: boolean,
 *   includePreload?: boolean,
 *   includeNitro?: boolean,
 * }} options
 */
export async function stagePrivateSourcemaps({
    projectRoot = process.cwd(),
    identity,
    outputRoots = DEFAULT_OUTPUT_ROOTS,
    reset = false,
    resetCompletedIdentityLock = false,
    removePublicOutputMaps = true,
    includePreload = false,
    includeNitro = true,
} = {}) {
    const normalizedIdentity = assertSentryBuildIdentity(identity);
    const root = path.resolve(projectRoot);
    const stageRoot = stageDirectory(root, normalizedIdentity);
    const manifestPath = stageManifestPath(root, normalizedIdentity);

    if (reset) {
        await rm(stageRoot, {
            recursive: true,
            force: true,
        });
        await rm(identityLockPath(root), {force: true});
    } else if (resetCompletedIdentityLock) {
        await resetCompletedIdentityLockOnConflict(root, normalizedIdentity);
    }
    await lockBuildIdentity(root, normalizedIdentity);

    const existingManifest = await readExistingManifest(manifestPath, normalizedIdentity);
    const existingBundles = manifestBundleMap(existingManifest);
    const existingUnmappedGeneratedBundles = manifestUnmappedGeneratedBundleMap(existingManifest);
    const stagedBundles = [];
    const unmappedGeneratedBundles = [];
    const removedMaps = [...(existingManifest?.removedPublicMaps ?? [])];
    const seenOutputRoots = new Set();
    let generatedBundleNames = null;

    for (const outputRoot of outputRoots) {
        const normalizedOutputRoot = normalizeOutputRoot(root, outputRoot);
        if (seenOutputRoots.has(normalizedOutputRoot)) {
            continue;
        }
        seenOutputRoots.add(normalizedOutputRoot);
        const absoluteOutputRoot = path.resolve(root, normalizedOutputRoot);
        if (!(await directoryExists(absoluteOutputRoot))) {
            continue;
        }
        const files = await collectFiles(absoluteOutputRoot);
        const candidates = files
            .filter(file => isJavaScriptBundle(file.relativePath))
            .map(file => ({
                ...file,
                role: classifyBundle(normalizedOutputRoot, file.relativePath, {
                    includePreload,
                    includeNitro,
                }),
            }))
            .filter(file => file.role !== null)
            .sort((left, right) => compareStrings(left.relativePath, right.relativePath));

        const mappedCandidates = [];
        for (const candidate of candidates) {
            const publicMapPath = path.join(
                absoluteOutputRoot,
                mapPathForBundle(candidate.relativePath),
            );
            if (await fileExists(publicMapPath)) {
                mappedCandidates.push(candidate);
                continue;
            }
            generatedBundleNames ??= await readNuxtGeneratedBrowserBundleNames(root);
            const generatedBundle = await describeUnmappedGeneratedBrowserBundle({
                candidate,
                generatedBundleNames,
                outputRoot: normalizedOutputRoot,
                projectRoot: root,
            });
            if (generatedBundle) {
                unmappedGeneratedBundles.push(generatedBundle);
                continue;
            }
            throw new Error(
                `Reportable bundle has no external source map: ${slashPath(path.join(normalizedOutputRoot, candidate.relativePath))}`,
            );
        }

        // The CLI mutates both files. Run it only after all build transforms
        // have completed and before hashing, staging, receipt computation, or
        // public-map removal.
        await injectDebugIds(mappedCandidates.flatMap(candidate => [
            candidate.absolutePath,
            `${candidate.absolutePath}.map`,
        ]));

        for (const candidate of mappedCandidates) {
            const mapRelativePath = mapPathForBundle(candidate.relativePath);
            const publicMapPath = path.join(absoluteOutputRoot, mapRelativePath);
            if (!(await fileExists(publicMapPath))) {
                throw new Error(
                    `Reportable bundle has no external source map: ${slashPath(path.join(normalizedOutputRoot, candidate.relativePath))}`,
                );
            }
            const stagedBundle = await stageBundle({
                projectRoot: root,
                outputRoot: normalizedOutputRoot,
                bundle: candidate.relativePath,
                role: candidate.role,
                mapPath: mapRelativePath,
                stageRoot,
            });
            const existing = existingBundles.get(stagedBundle.bundle);
            if (existing && existing.mapSha256 !== stagedBundle.mapSha256) {
                throw new Error(`Conflicting source maps for ${stagedBundle.bundle}`);
            }
            stagedBundles.push(stagedBundle);
        }

        if (removePublicOutputMaps) {
            removedMaps.push(...(await removeMaps(absoluteOutputRoot)).map(map =>
                slashPath(path.join(normalizedOutputRoot, map))));
        }
    }

    const bundles = new Map(existingBundles);
    const generatedBundles = new Map(existingUnmappedGeneratedBundles);
    for (const bundle of stagedBundles) {
        bundles.set(bundle.bundle, bundle);
        generatedBundles.delete(bundle.bundle);
    }
    for (const bundle of unmappedGeneratedBundles) {
        generatedBundles.set(bundle.bundle, bundle);
        bundles.delete(bundle.bundle);
    }
    const manifest = {
        bundles: [...bundles.values()].sort((left, right) => compareStrings(left.bundle, right.bundle)),
        identity: normalizedIdentity,
        removedPublicMaps: [...new Set(removedMaps)].sort(compareStrings),
        schemaVersion: PRIVATE_SOURCEMAP_MANIFEST_SCHEMA_VERSION,
        sources: collectSourceEntries(bundles.values()),
        unmappedGeneratedBundles: [...generatedBundles.values()]
            .sort((left, right) => compareStrings(left.bundle, right.bundle)),
    };
    await writeManifest(manifestPath, manifest);

    if (removePublicOutputMaps) {
        await assertPublicOutputMapFree({
            projectRoot: root,
            outputRoots,
        });
    }

    process.stdout.write(
        `Staged ${manifest.bundles.length} private Sentry source map(s) for `
        + `${normalizedIdentity.release}, ${normalizedIdentity.dist}, ${normalizedIdentity.environment}.\n`,
    );
    for (const bundle of manifest.bundles) {
        process.stdout.write(`Private Sentry map: ${bundle.bundle} -> ${bundle.stagedMapPath}\n`);
    }
    if (manifest.unmappedGeneratedBundles.length > 0) {
        process.stdout.write(
            `Recorded ${manifest.unmappedGeneratedBundles.length} generated browser bundle(s) without source maps.\n`,
        );
    }
    return manifest;
}

export async function assertPublicOutputMapFree({
    projectRoot = process.cwd(),
    outputRoots = DEFAULT_OUTPUT_ROOTS,
} = {}) {
    const root = path.resolve(projectRoot);
    const maps = [];
    for (const outputRoot of outputRoots) {
        const normalizedOutputRoot = normalizeOutputRoot(root, outputRoot);
        const absoluteOutputRoot = path.resolve(root, normalizedOutputRoot);
        if (!(await directoryExists(absoluteOutputRoot))) {
            continue;
        }
        const files = await collectFiles(absoluteOutputRoot);
        maps.push(...files
            .filter(file => file.relativePath.endsWith('.map'))
            .map(file => slashPath(path.join(normalizedOutputRoot, file.relativePath))));
    }
    if (maps.length > 0) {
        throw new Error(`Public output contains source maps: ${maps.sort(compareStrings).join(', ')}`);
    }
    return true;
}

/**
 * @param {{
 *   projectRoot?: string,
 *   identity: import('@contracts/diagnostics/releaseIdentity.js').SentryBuildIdentity,
 * }} options
 */
export function getPrivateSourcemapManifestPath({
    projectRoot = process.cwd(),
    identity,
} = {}) {
    return stageManifestPath(path.resolve(projectRoot), assertSentryBuildIdentity(identity));
}

export function getSentryBuildIdentityLockPath({projectRoot = process.cwd()} = {}) {
    return identityLockPath(path.resolve(projectRoot));
}

export function getSentryBuildIdentityKey(identity) {
    return sentryBuildIdentityKey(assertSentryBuildIdentity(identity));
}
