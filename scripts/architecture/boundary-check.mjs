#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildDependencyGraph } from './dep-graph.mjs';

const APP_MODULE_PUBLIC_ENTRYPOINTS = new Set([
    'index.ts',
    'index.tsx',
    'index.js',
    'index.mjs',
    'public.ts',
    'public.tsx',
    'public.js',
    'public.mjs',
    'public/index.ts',
    'public/index.tsx',
    'public/index.js',
    'public/index.mjs',
]);

const ELECTRON_FEATURE_PUBLIC_ENTRYPOINTS = new Set(APP_MODULE_PUBLIC_ENTRYPOINTS);

function matchesRoot(filePath, root) {
    return filePath === root || filePath.startsWith(`${root}/`);
}

function getFeatureOwner(filePath, prefix) {
    if (!matchesRoot(filePath, prefix)) {
        return null;
    }

    const rest = filePath.slice(`${prefix}/`.length);
    const [featureName] = rest.split('/');
    return featureName || null;
}

function relativeWithinOwner(filePath, prefix, owner) {
    return filePath.slice(`${prefix}/${owner}/`.length);
}

function isAllowedPublicEntrypoint(relativePath, allowedSet) {
    return allowedSet.has(relativePath);
}

function createViolation({
    rule,
    source,
    target,
    specifier,
    message,
}) {
    return {
        rule,
        source,
        target,
        specifier,
        message,
    };
}

function checkEdge(edge) {
    const violations = [];
    const {
        source,
        target,
        specifier,
    } = edge;

    if (matchesRoot(source, 'electron') && matchesRoot(target, 'app')) {
        violations.push(createViolation({
            rule: 'electron-to-app',
            source,
            target,
            specifier,
            message: 'Electron code must not import app runtime code.',
        }));
    }

    if (matchesRoot(source, 'landing') && matchesRoot(target, 'app')) {
        violations.push(createViolation({
            rule: 'landing-to-app',
            source,
            target,
            specifier,
            message: 'Landing code must not import app runtime code.',
        }));
    }

    if (matchesRoot(source, 'app/services') && matchesRoot(target, 'app/composables')) {
        violations.push(createViolation({
            rule: 'services-to-composables',
            source,
            target,
            specifier,
            message: 'app/services must not depend on app/composables.',
        }));
    }

    const sourceAppModule = getFeatureOwner(source, 'app/modules');
    const targetAppModule = getFeatureOwner(target, 'app/modules');
    if (sourceAppModule && targetAppModule && sourceAppModule !== targetAppModule) {
        const relativePath = relativeWithinOwner(target, 'app/modules', targetAppModule);
        if (!isAllowedPublicEntrypoint(relativePath, APP_MODULE_PUBLIC_ENTRYPOINTS)) {
            violations.push(createViolation({
                rule: 'app-cross-feature-deep-import',
                source,
                target,
                specifier,
                message: 'Cross-feature imports in app/modules must use public entrypoints only.',
            }));
        }
    }

    const sourceElectronFeature = getFeatureOwner(source, 'electron/features');
    const targetElectronFeature = getFeatureOwner(target, 'electron/features');
    if (sourceElectronFeature && targetElectronFeature && sourceElectronFeature !== targetElectronFeature) {
        const relativePath = relativeWithinOwner(target, 'electron/features', targetElectronFeature);
        if (!isAllowedPublicEntrypoint(relativePath, ELECTRON_FEATURE_PUBLIC_ENTRYPOINTS)) {
            violations.push(createViolation({
                rule: 'electron-cross-feature-deep-import',
                source,
                target,
                specifier,
                message: 'Cross-feature imports in electron/features must use public entrypoints only.',
            }));
        }
    }

    return violations;
}

function formatViolations(violations) {
    return violations.map((violation, index) => {
        const serial = index + 1;
        return [
            `${serial}. [${violation.rule}] ${violation.message}`,
            `   source: ${violation.source}`,
            `   target: ${violation.target}`,
            `   import: ${violation.specifier}`,
        ].join('\n');
    }).join('\n');
}

async function run() {
    const graph = await buildDependencyGraph({projectRoot: process.cwd()});

    const violations = graph.edges.flatMap(checkEdge);

    if (violations.length > 0) {
        console.error('Architecture boundary check failed.');
        console.error(formatViolations(violations));
        process.exit(1);
    }

    console.log(`Architecture boundary check passed (${graph.edges.length} internal imports scanned).`);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    run().catch(error => {
        console.error('[boundary-check] Unexpected failure.');
        console.error(error);
        process.exit(1);
    });
}
