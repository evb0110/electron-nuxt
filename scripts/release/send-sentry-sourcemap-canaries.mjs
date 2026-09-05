import {createHash} from 'node:crypto';
import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    createEventEnvelope,
    getEnvelopeEndpointWithUrlEncodedAuth,
    makeDsn,
    serializeEnvelope,
} from '@sentry/core';
import sourceMap from 'source-map-js';
import {
    assertSameSentryBuildIdentity,
    assertSentryBuildIdentity,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';
import {getPrivateSourcemapManifestPath} from './stage-private-sourcemaps.mjs';

const {SourceMapConsumer} = sourceMap;
export const CANARY_RECEIPT_SCHEMA_VERSION = 2;
export const CANARY_EVENT_VERSION = 'sourcemap-v6';
const DEBUG_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;
const SENTRY_INGEST_ATTEMPTS = 5;
const SENTRY_INGEST_RETRY_BASE_MS = 500;
const SENTRY_INGEST_RETRY_MAX_MS = 30_000;
const SENTRY_INGEST_TIMEOUT_MS = 30_000;

function readIdentity(environment) {
    return assertSentryBuildIdentity({
        target: environment.EVB_SENTRY_TARGET,
        release: environment.EVB_SENTRY_RELEASE,
        dist: environment.EVB_SENTRY_DIST,
        environment: environment.EVB_SENTRY_ENVIRONMENT,
    });
}

function requireCanaryDsn(identity, environment) {
    const key = identity.target === 'desktop'
        ? 'SENTRY_DESKTOP_DSN'
        : 'SENTRY_BROWSER_DSN';
    const candidate = environment[key]?.trim() ?? '';
    const parsed = makeDsn(candidate);
    if (
        parsed === undefined
        || parsed.protocol !== 'https'
        || !parsed.publicKey
        || parsed.pass
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(parsed.host)
        || !/^\d+$/u.test(parsed.projectId)
    ) {
        throw new Error(`Missing or invalid EU Sentry canary DSN in ${key}`);
    }
    return parsed;
}

function normalizePath(value) {
    let normalized = value.replaceAll('\\', '/');
    try {
        normalized = decodeURIComponent(normalized);
    } catch {
        return '';
    }
    return normalized
        .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u, '')
        .replace(/^\/+/, '')
        .replace(/^(?:\.\.\/)+/u, '');
}

function resolveInside(root, relativePath, label) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        throw new Error(`${label} must be a non-empty relative path`);
    }
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    if (
        resolvedPath === resolvedRoot
        || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
        throw new Error(`${label} escapes the private source-map stage`);
    }
    return resolvedPath;
}

function matchManifestSource(mapSource, manifestSources) {
    const normalizedMapSource = normalizePath(mapSource);
    const matches = manifestSources.filter(source => {
        const normalizedSource = normalizePath(source);
        return normalizedMapSource === normalizedSource
            || normalizedMapSource.endsWith(`/${normalizedSource}`);
    });
    return matches.length === 1 ? matches[0] : null;
}

export function findCanaryMapping(mapPayload, manifestSources) {
    const consumer = new SourceMapConsumer(mapPayload);
    let first = null;
    let named = null;
    consumer.eachMapping(mapping => {
        if (
            typeof mapping.source !== 'string'
            || !Number.isSafeInteger(mapping.generatedLine)
            || !Number.isSafeInteger(mapping.generatedColumn)
            || !Number.isSafeInteger(mapping.originalLine)
            || !Number.isSafeInteger(mapping.originalColumn)
        ) {
            return;
        }
        const source = matchManifestSource(mapping.source, manifestSources);
        if (source === null) {
            return;
        }
        const candidate = {
            generatedColumn: mapping.generatedColumn + 1,
            generatedLine: mapping.generatedLine,
            originalColumn: mapping.originalColumn + 1,
            originalFunction: typeof mapping.name === 'string' && mapping.name.length > 0
                ? mapping.name
                : null,
            originalLine: mapping.originalLine,
            originalSource: source,
        };
        first ??= candidate;
        if (candidate.originalFunction !== null) {
            named ??= candidate;
        }
    });
    return named ?? first;
}

function readDebugId(mapPayload) {
    const value = mapPayload.debug_id ?? mapPayload.debugId;
    if (typeof value !== 'string' || !DEBUG_ID_PATTERN.test(value)) {
        throw new Error('Private source map has no valid injected Debug ID');
    }
    return value;
}

export function getCanaryCodeFile(identity, bundlePath) {
    const vercelStaticPrefix = '.vercel/output/static/';
    if (identity.target === 'web' && bundlePath.startsWith(vercelStaticPrefix)) {
        return `https://evb-viewer.invalid/${bundlePath.slice(vercelStaticPrefix.length)}`;
    }
    return bundlePath;
}

export function getCanaryEventId(identity, bundlePath) {
    return createHash('sha256')
        .update(`evb-${CANARY_EVENT_VERSION}`)
        .update('\0')
        .update(identity.target)
        .update('\0')
        .update(identity.release)
        .update('\0')
        .update(identity.dist)
        .update('\0')
        .update(identity.environment)
        .update('\0')
        .update(bundlePath)
        .digest('hex')
        .slice(0, 32);
}

function createCanaryEvent(identity, bundle, mapping, debugId) {
    const codeFile = getCanaryCodeFile(identity, bundle.bundle);
    const eventId = getCanaryEventId(identity, bundle.bundle);
    return {
        event: {
            event_id: eventId,
            timestamp: Date.now() / 1_000,
            level: 'error',
            platform: 'javascript',
            logger: 'evb-viewer.sourcemap-canary',
            release: identity.release,
            dist: identity.dist,
            environment: identity.environment,
            fingerprint: [
                `evb-${CANARY_EVENT_VERSION}`,
                identity.dist,
                bundle.bundle,
            ],
            exception: {values: [{
                type: 'EVBViewerSourceMapCanary',
                value: 'EVB Viewer source-map canary',
                stacktrace: {frames: [{
                    abs_path: codeFile,
                    filename: codeFile,
                    module: codeFile,
                    function: 'evbViewerSourceMapCanary',
                    lineno: mapping.generatedLine,
                    colno: mapping.generatedColumn,
                    in_app: true,
                }]},
            }]},
            tags: {
                evb_schema: 'evb-diagnostic-v1',
                evb_canary: CANARY_EVENT_VERSION,
                bundle_role: bundle.role,
            },
            debug_meta: {images: [{
                type: 'sourcemap',
                code_file: codeFile,
                debug_id: debugId,
            }]},
        },
        evidence: {
            bundle: bundle.bundle,
            codeFile,
            debugId,
            eventId,
            expectedFunction: mapping.originalFunction,
            expectedLine: mapping.originalLine,
            expectedSource: mapping.originalSource,
            role: bundle.role,
        },
    };
}

function isRetryableIngestStatus(status) {
    return status === 408
        || status === 425
        || status === 429
        || status >= 500;
}

function retryAfterMilliseconds(response) {
    const rawValue = response.headers?.get?.('retry-after')?.trim() ?? '';
    if (!rawValue) {
        return null;
    }
    const seconds = Number(rawValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(SENTRY_INGEST_RETRY_MAX_MS, Math.ceil(seconds * 1_000));
    }
    const retryAt = Date.parse(rawValue);
    if (!Number.isFinite(retryAt)) {
        return null;
    }
    return Math.min(
        SENTRY_INGEST_RETRY_MAX_MS,
        Math.max(0, retryAt - Date.now()),
    );
}

function defaultRetryDelay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function sendEnvelope(event, dsn, {
    fetchImpl = globalThis.fetch,
    sleep = defaultRetryDelay,
} = {}) {
    const endpoint = getEnvelopeEndpointWithUrlEncodedAuth(dsn);
    const body = serializeEnvelope(createEventEnvelope(event, dsn));
    for (let attempt = 1; attempt <= SENTRY_INGEST_ATTEMPTS; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {'content-type': 'application/x-sentry-envelope'},
                body,
                redirect: 'error',
                signal: AbortSignal.timeout(SENTRY_INGEST_TIMEOUT_MS),
            });
        } catch (error) {
            if (attempt === SENTRY_INGEST_ATTEMPTS) {
                throw new Error(
                    `Sentry canary ingest failed after ${String(attempt)} attempts`,
                    {cause: error},
                );
            }
            await sleep(Math.min(
                SENTRY_INGEST_RETRY_MAX_MS,
                SENTRY_INGEST_RETRY_BASE_MS * (2 ** (attempt - 1)),
            ));
            continue;
        }
        if (response.ok) {
            return;
        }
        if (!isRetryableIngestStatus(response.status) || attempt === SENTRY_INGEST_ATTEMPTS) {
            throw new Error(
                `Sentry canary ingest returned HTTP ${String(response.status)} after ${String(attempt)} attempt(s)`,
            );
        }
        await sleep(retryAfterMilliseconds(response) ?? Math.min(
            SENTRY_INGEST_RETRY_MAX_MS,
            SENTRY_INGEST_RETRY_BASE_MS * (2 ** (attempt - 1)),
        ));
    }
}

export async function sendSentrySourcemapCanaries({
    environment = process.env,
    projectRoot = process.cwd(),
    sendEvent = sendEnvelope,
} = {}) {
    const identity = readIdentity(environment);
    if (
        identity.environment === 'production'
        && environment.EVB_SENTRY_CANARY_ALLOW_PRODUCTION !== '1'
    ) {
        throw new Error('Production Sentry canaries require an explicit one-run override');
    }
    const root = path.resolve(projectRoot);
    const manifestPath = getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assertSameSentryBuildIdentity(identity, manifest.identity);
    if (!Array.isArray(manifest.bundles) || manifest.bundles.length === 0) {
        throw new Error('Private source-map manifest has no canary bundles');
    }
    const dsn = requireCanaryDsn(identity, environment);
    const stageRoot = path.dirname(manifestPath);
    const evidence = [];
    const skippedBundles = [];
    for (const bundle of manifest.bundles) {
        if (!Array.isArray(bundle.sources) || bundle.sources.length === 0) {
            skippedBundles.push({
                bundle: bundle.bundle,
                reason: 'no-project-source',
                role: bundle.role,
            });
            continue;
        }
        const mapPayload = JSON.parse(await readFile(
            resolveInside(stageRoot, bundle.stagedMapPath, 'Canary source-map path'),
            'utf8',
        ));
        const debugId = readDebugId(mapPayload);
        const mapping = findCanaryMapping(mapPayload, bundle.sources);
        if (mapping === null) {
            skippedBundles.push({
                bundle: bundle.bundle,
                reason: 'no-project-mapping',
                role: bundle.role,
            });
            continue;
        }
        const canary = createCanaryEvent(identity, bundle, mapping, debugId);
        await sendEvent(canary.event, dsn);
        evidence.push(canary.evidence);
        const expectedFunction = canary.evidence.expectedFunction ?? '<anonymous>';
        process.stdout.write(
            `Sentry source-map canary submitted: ${bundle.role}, ${bundle.bundle}, `
            + `${canary.evidence.eventId}, expects ${canary.evidence.expectedSource}:`
            + `${String(canary.evidence.expectedLine)} ${expectedFunction}\n`,
        );
    }
    const receipt = {
        schemaVersion: CANARY_RECEIPT_SCHEMA_VERSION,
        identity,
        events: evidence,
        skippedBundles,
    };
    await writeFile(
        path.join(stageRoot, 'canary-receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
        {mode: 0o600},
    );
    process.stdout.write(
        `Sentry submitted ${String(evidence.length)} source-map canary event(s) for ${identity.release}, ${identity.dist}.\n`,
    );
    if (skippedBundles.length > 0) {
        process.stdout.write(
            `Recorded ${String(skippedBundles.length)} generated or vendor-only bundle(s) without an EVB source mapping.\n`,
        );
    }
    return receipt;
}

function isDirectInvocation() {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
}

if (isDirectInvocation()) {
    await sendSentrySourcemapCanaries();
}
