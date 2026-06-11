#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildDependencyGraph } from './dep-graph.mjs';

const APP_MODULE_PUBLIC_ENTRYPOINTS = new Set([
    'public',
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
ELECTRON_FEATURE_PUBLIC_ENTRYPOINTS.add('contract.ts');

const ROOT_BOUNDARY_RULES = [
    {
        sourceRoot: 'electron',
        targetRoot: 'app',
        rule: 'electron-to-app',
        message: 'Electron code must not import app runtime code.',
    },
    {
        sourceRoot: 'landing',
        targetRoot: 'app',
        rule: 'landing-to-app',
        message: 'Landing code must not import app runtime code.',
    },
    {
        sourceRoot: 'landing',
        targetRoot: 'electron',
        rule: 'landing-to-electron',
        message: 'Landing code must not import electron runtime code.',
    },
    {
        sourceRoot: 'electron',
        targetRoot: 'landing',
        rule: 'electron-to-landing',
        message: 'Electron code must not import landing runtime code.',
    },
    {
        sourceRoot: 'app',
        targetRoot: 'landing',
        rule: 'app-to-landing',
        message: 'App code must not import landing runtime code.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'app',
        rule: 'packages-to-app',
        message: 'Shared packages must not import app runtime code.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'electron',
        rule: 'packages-to-electron',
        message: 'Shared packages must not import electron runtime code.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'landing',
        rule: 'packages-to-landing',
        message: 'Shared packages must not import landing runtime code.',
    },
    {
        sourceRoot: 'app/services',
        targetRoot: 'app/composables',
        rule: 'services-to-composables',
        message: 'app/services must not depend on app/composables.',
    },
    {
        sourceRoot: 'scripts',
        targetRoot: 'electron',
        rule: 'scripts-to-electron',
        message: 'scripts/** must not import electron runtime code.',
    },
    {
        sourceRoot: 'server',
        targetRoot: 'electron',
        rule: 'server-to-electron',
        message: 'server/** must not import electron runtime code.',
    },
    {
        sourceRoot: 'server',
        targetRoot: 'landing',
        rule: 'server-to-landing',
        message: 'server/** must not import landing runtime code.',
    },
    {
        sourceRoot: 'app',
        targetRoot: 'server',
        rule: 'app-to-server',
        message: 'app/** must not import server runtime code.',
    },
    {
        sourceRoot: 'electron',
        targetRoot: 'server',
        rule: 'electron-to-server',
        message: 'electron/** must not import server runtime code.',
    },
    {
        sourceRoot: 'landing',
        targetRoot: 'server',
        rule: 'landing-to-server',
        message: 'landing/** must not import server runtime code.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'server',
        rule: 'packages-to-server',
        message: 'Shared packages must not import server runtime code.',
    },
];

const PUBLIC_ONLY_INTERNAL_ENTRYPOINTS = [ {
    ownerRoot: 'app/platform/browser-api',
    publicEntry: 'public.ts',
    rule: 'browser-api-public-entrypoint',
    message: 'Browser platform API consumers must import through app/platform/browser-api/public.',
} ];

const PLATFORM_API_ALLOWED_CONSUMERS = new Set(`
app/modules/workspace-shell/menu/registerTabsMenuBindings.ts
app/platform/browserPlatformApi.ts
app/platform/lazyBrowserPlatformApi.ts
app/types/electron.d.ts
app/utils/getViewerHostApi.ts
app/utils/platform.ts
packages/contracts/electronApi.ts
packages/contracts/index.ts
`.trim().split('\n'));

const FEATURE_BOUNDARY_RULES = [
    {
        prefix: 'app/modules',
        rule: 'app-cross-feature-deep-import',
        allowedEntrypoints: APP_MODULE_PUBLIC_ENTRYPOINTS,
        message: 'Cross-feature imports in app/modules must use public entrypoints only.',
    },
    {
        prefix: 'electron/features',
        rule: 'electron-cross-feature-deep-import',
        allowedEntrypoints: ELECTRON_FEATURE_PUBLIC_ENTRYPOINTS,
        message: 'Cross-feature imports in electron/features must use public entrypoints only.',
    },
];

function checkElectronFeatureMainPrivacy(edge) {
    const targetOwner = getFeatureOwner(edge.target, 'electron/features');
    if (!targetOwner) {
        return null;
    }

    const targetRelativePath = relativeWithinOwner(edge.target, 'electron/features', targetOwner);
    if (!targetRelativePath.startsWith('main/')) {
        return null;
    }

    const sourceOwner = getFeatureOwner(edge.source, 'electron/features');
    if (sourceOwner === targetOwner) {
        return null;
    }

    return createViolation({
        rule: 'electron-feature-main-private',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'Electron feature main internals must be consumed through feature public or service entrypoints.',
    });
}

function isInsideComponentDirectory(filePath) {
    return filePath.split('/').includes('components');
}

function checkComponentDirectoryFilePlacement(filePath) {
    if (!isInsideComponentDirectory(filePath) || filePath.endsWith('.vue')) {
        return null;
    }

    return createViolation({
        rule: 'component-directory-non-vue-source',
        source: filePath,
        target: filePath,
        specifier: 'filesystem',
        message: 'Component directories must contain Vue SFCs only; move helpers, state, and schedulers into feature modules.',
    });
}

function checkPublicOnlyInternalEntrypoint(edge, boundaryRule) {
    if (!matchesRoot(edge.source, 'app') || !matchesRoot(edge.target, boundaryRule.ownerRoot)) {
        return null;
    }
    if (matchesRoot(edge.source, boundaryRule.ownerRoot)) {
        return null;
    }

    const targetRelativePath = edge.target.slice(`${boundaryRule.ownerRoot}/`.length);
    if (targetRelativePath === boundaryRule.publicEntry) {
        return null;
    }

    return createViolation({
        rule: boundaryRule.rule,
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: boundaryRule.message,
    });
}

function checkPlatformApiAggregateImport(edge) {
    if (edge.target !== 'packages/contracts/platformApi.ts') {
        return null;
    }
    if (PLATFORM_API_ALLOWED_CONSUMERS.has(edge.source)) {
        return null;
    }

    return createViolation({
        rule: 'platform-api-aggregate-import',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'Import narrow platform capability contracts instead of the aggregate IPlatformApi contract.',
    });
}

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
    return allowedSet.has(relativePath) || relativePath.startsWith('public/');
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

function checkRootBoundaryRule(edge, boundaryRule) {
    const {
        source,
        target,
        specifier,
    } = edge;

    return matchesRoot(source, boundaryRule.sourceRoot) && matchesRoot(target, boundaryRule.targetRoot)
        ? createViolation({
            rule: boundaryRule.rule,
            source,
            target,
            specifier,
            message: boundaryRule.message,
        })
        : null;
}

function checkFeatureBoundaryRule(edge, featureRule) {
    const sourceOwner = getFeatureOwner(edge.source, featureRule.prefix);
    const targetOwner = getFeatureOwner(edge.target, featureRule.prefix);
    if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) {
        return null;
    }

    const relativePath = relativeWithinOwner(edge.target, featureRule.prefix, targetOwner);
    if (isAllowedPublicEntrypoint(relativePath, featureRule.allowedEntrypoints)) {
        return null;
    }

    return createViolation({
        rule: featureRule.rule,
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: featureRule.message,
    });
}

function collectViolationsFromRules(edge, rules, checkRule) {
    return rules
        .map(rule => checkRule(edge, rule))
        .filter(Boolean);
}

function checkEdge(edge) {
    return [
        ...collectViolationsFromRules(edge, ROOT_BOUNDARY_RULES, checkRootBoundaryRule),
        ...collectViolationsFromRules(edge, FEATURE_BOUNDARY_RULES, checkFeatureBoundaryRule),
        ...collectViolationsFromRules(edge, PUBLIC_ONLY_INTERNAL_ENTRYPOINTS, checkPublicOnlyInternalEntrypoint),
        checkPlatformApiAggregateImport(edge),
        checkElectronFeatureMainPrivacy(edge),
    ].filter(Boolean);
}

export function checkArchitectureBoundaryEdge(edge) {
    return checkEdge(edge);
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

function formatCycles(cycles) {
    return cycles.map((cycle, index) => {
        const serial = index + 1;
        return [
            `${serial}. Dependency cycle detected:`,
            ...cycle.files.map(file => `   - ${file}`),
        ].join('\n');
    }).join('\n');
}

function collectRootsFromArgv(argv) {
    const rootArg = argv.find(argument => argument.startsWith('--roots='));
    if (!rootArg) {
        return null;
    }

    return rootArg
        .slice('--roots='.length)
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .map(root => root.split(path.sep).join('/'))
        .filter(root => !path.isAbsolute(root));
}

async function run() {
    const roots = collectRootsFromArgv(process.argv.slice(2));
    const graph = await buildDependencyGraph({
        projectRoot: process.cwd(),
        ...(roots === null ? {} : {roots}),
    });

    const violations = [
        ...graph.edges.flatMap(checkEdge),
        ...graph.nodes
            .map(node => checkComponentDirectoryFilePlacement(node.file))
            .filter(Boolean),
    ];
    const unresolvedInternalImports = graph.unresolvedInternalImports ?? [];
    const cycles = graph.cycles ?? [];

    if (violations.length > 0 || unresolvedInternalImports.length > 0 || cycles.length > 0) {
        console.error('Architecture boundary check failed.');
        if (violations.length > 0) {
            console.error(formatViolations(violations));
        }
        if (cycles.length > 0) {
            console.error('Dependency cycles detected:');
            console.error(formatCycles(cycles));
        }
        if (unresolvedInternalImports.length > 0) {
            console.error('Unresolved internal imports detected:');
            for (const [
                index,
                unresolved,
            ] of unresolvedInternalImports.entries()) {
                console.error(
                    `${index + 1}. source: ${unresolved.source}\n   import: ${unresolved.specifier}`,
                );
            }
        }
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
