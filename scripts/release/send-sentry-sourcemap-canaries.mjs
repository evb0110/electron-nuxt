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
const CANARY_RECEIPT_SCHEMA_VERSION = 1;
const DEBUG_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;

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

function findCanaryMapping(mapPayload, manifestSources) {
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
    const selected = named ?? first;
    if (selected === null) {
        throw new Error('Private source map has no project-source mapping for a canary');
    }
    return selected;
}

function readDebugId(mapPayload) {
    const value = mapPayload.debug_id ?? mapPayload.debugId;
    if (typeof value !== 'string' || !DEBUG_ID_PATTERN.test(value)) {
        throw new Error('Private source map has no valid injected Debug ID');
    }
    return value;
}

function createCanaryEvent(identity, bundle, mapping, debugId) {
    const eventId = createHash('sha256')
        .update('evb-sourcemap-canary-v1')
        .update('\0')
        .update(identity.target)
        .update('\0')
        .update(identity.release)
        .update('\0')
        .update(identity.dist)
        .update('\0')
        .update(identity.environment)
        .update('\0')
        .update(bundle.bundle)
        .digest('hex')
        .slice(0, 32);
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
                'evb-sourcemap-canary-v1',
                identity.dist,
                bundle.bundle,
            ],
            exception: {values: [{
                type: 'EVBViewerSourceMapCanary',
                value: 'EVB Viewer source-map canary',
                stacktrace: {frames: [{
                    filename: bundle.bundle,
                    module: bundle.bundle,
                    function: 'evbViewerSourceMapCanary',
                    lineno: mapping.generatedLine,
                    colno: mapping.generatedColumn,
                    in_app: true,
                }]},
            }]},
            tags: {
                evb_schema: 'evb-diagnostic-v1',
                evb_canary: 'sourcemap-v1',
                bundle_role: bundle.role,
            },
            debug_meta: {images: [{
                type: 'sourcemap',
                code_file: bundle.bundle,
                debug_id: debugId,
            }]},
        },
        evidence: {
            bundle: bundle.bundle,
            eventId,
            expectedFunction: mapping.originalFunction,
            expectedLine: mapping.originalLine,
            expectedSource: mapping.originalSource,
            role: bundle.role,
        },
    };
}

async function sendEnvelope(event, dsn) {
    const endpoint = getEnvelopeEndpointWithUrlEncodedAuth(dsn);
    const body = serializeEnvelope(createEventEnvelope(event, dsn));
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/x-sentry-envelope'},
        body,
        redirect: 'error',
    });
    if (!response.ok) {
        throw new Error(`Sentry canary ingest returned HTTP ${String(response.status)}`);
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
        const mapping = findCanaryMapping(mapPayload, bundle.sources);
        const canary = createCanaryEvent(identity, bundle, mapping, readDebugId(mapPayload));
        await sendEvent(canary.event, dsn);
        evidence.push(canary.evidence);
        const expectedFunction = canary.evidence.expectedFunction ?? '<anonymous>';
        process.stdout.write(
            `Sentry source-map canary accepted: ${bundle.role}, ${bundle.bundle}, `
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
        `Sentry accepted ${String(evidence.length)} source-map canary event(s) for ${identity.release}, ${identity.dist}.\n`,
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
