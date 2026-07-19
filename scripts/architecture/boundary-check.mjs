#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildDependencyGraph } from './dep-graph.mjs';
import {
    checkAnnotationDependencyEdge,
    checkAnnotationDependencyGraph,
} from './annotation-dependency-graph.mjs';
import {
    parseArchitectureRootsArg,
    parseArchitectureScopeArg,
} from './architectureCliArgs.mjs';
import { getFocusedArchitectureRoots } from '../workspace-roots.mjs';
import { RUNTIME_TOOL_BOUNDARY_RULES } from './runtimeToolBoundaryRules.mjs';

const APP_MODULE_PUBLIC_ENTRYPOINTS = new Set([
    'public',
    'index.ts',
    'index.tsx',
    'index.js',
    'index.mjs',
    'public.ts',
    'public.tsx',
    'publicNative.ts',
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
        sourceRoot: 'scripts',
        targetRoot: 'app',
        rule: 'scripts-to-app',
        message: 'scripts/** must not import app runtime code; diagnostic scripts may use only approved app trace/test types.',
    },
    ...RUNTIME_TOOL_BOUNDARY_RULES,
];

const SCRIPTS_TO_APP_ALLOWED_EDGES = new Set(`
scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/logPdfNav.ts
scripts/diagnostics/pdfTraceEntryGuards.ts -> app/utils/pdfRenderTrace.ts
scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/types/workspaceExpose.ts
scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/logPdfNav.ts
scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts -> app/utils/pdfRenderTrace.ts
scripts/diagnostics/pdfNavigationBlinkTrace.ts -> app/types/evbTestApi.ts
`.trim().split('\n'));

const PACKAGE_LAYER_RULES = [
    {
        sourceRoot: 'packages/contracts',
        allowedTargetRoots: [
            'packages/contracts',
            'packages/i18n-core',
        ],
        rule: 'packages-contracts-layer',
        message: 'packages/contracts may depend only on itself and i18n-core leaf utilities.',
    },
    {
        sourceRoot: 'packages/pdf-core',
        allowedTargetRoots: [
            'packages/pdf-core',
            'packages/contracts',
        ],
        rule: 'packages-pdf-core-layer',
        message: 'packages/pdf-core may depend only on itself and contracts.',
    },
    {
        sourceRoot: 'packages/i18n-core',
        allowedTargetRoots: ['packages/i18n-core'],
        rule: 'packages-i18n-core-layer',
        message: 'packages/i18n-core must stay a leaf utility package with no other package dependencies.',
    },
    {
        sourceRoot: 'packages/i18n-app',
        allowedTargetRoots: [
            'packages/i18n-app',
            'packages/i18n-core',
        ],
        rule: 'packages-i18n-app-layer',
        message: 'packages/i18n-app may depend only on itself and i18n-core.',
    },
    {
        sourceRoot: 'packages/release-selection',
        allowedTargetRoots: [
            'packages/release-selection',
            'packages/contracts',
        ],
        rule: 'packages-release-selection-layer',
        message: 'packages/release-selection may depend only on itself and contracts.',
    },
    {
        sourceRoot: 'packages/electron-worker-bundles',
        allowedTargetRoots: ['packages/electron-worker-bundles'],
        rule: 'packages-electron-worker-bundles-layer',
        message: 'packages/electron-worker-bundles must not depend on other workspace packages.',
    },
];

const PUBLIC_ONLY_INTERNAL_ENTRYPOINTS = [ {
    ownerRoot: 'app/platform/browser-api',
    publicEntry: 'public.ts',
    rule: 'browser-api-public-entrypoint',
    message: 'Browser platform API consumers must import through app/platform/browser-api/public.',
} ];

const PLATFORM_API_AGGREGATE_COMPOSITION_FILES = new Set(`
app/platform/browserPlatformApi.ts
app/platform/generated/createLazyBrowserPlatformApiGenerated.ts
app/platform/lazyBrowserPlatformApi.ts
app/utils/platform.ts
`.trim().split('\n'));

const PLATFORM_API_AGGREGATE_TYPE_BOUNDARY_FILES = new Set(`
app/platform/browserPlatformPathDescriptors.ts
app/types/electron.d.ts
packages/contracts/electronApi.ts
packages/contracts/index.ts
`.trim().split('\n'));

const PLATFORM_API_AGGREGATE_IMPORT_BOUNDARY_FILES = new Set([
    ...PLATFORM_API_AGGREGATE_COMPOSITION_FILES,
    ...PLATFORM_API_AGGREGATE_TYPE_BOUNDARY_FILES,
]);

const PLATFORM_API_RUNTIME_GETTER_ALLOWED_FILES = new Set(`
app/utils/platformDocuments.ts
app/utils/getShellCapability.ts
app/utils/getSettingsCapability.ts
app/utils/getDjvuCapability.ts
app/utils/getOcrCapability.ts
app/utils/getScanCleanupCapability.ts
app/utils/getSearchCapability.ts
app/utils/platformUpdates.ts
app/utils/platformWindowTabs.ts
app/utils/getAgentCapability.ts
app/utils/getHostCapability.ts
app/utils/getSystemCapability.ts
`.trim().split('\n'));

const PLATFORM_API_RUNTIME_HELPER_MODULE_PATH = 'app/utils/platform';
const APP_PRODUCTION_SOURCE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
];

const ANNOTATION_STORAGE_PRIVATE_ACCESS_ALLOWED_FILES = new Set(['app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges.ts']);

const ANNOTATION_STORAGE_PRIVATE_MEMBERS = [
    'serializable',
    'modifiedIds',
    'resetModified',
    'resetModifiedIds',
];

const PDF_VIEWER_MODULE_ROOT = 'app/modules/pdf-viewer';
const PDF_VIEWER_ENGINE_ROOT = `${PDF_VIEWER_MODULE_ROOT}/engine`;
const PDF_VIEWER_ENGINE_ALLOWED_TARGET_ROOTS = [
    PDF_VIEWER_ENGINE_ROOT,
    `${PDF_VIEWER_MODULE_ROOT}/dom`,
];

const ELECTRON_LEGACY_FEATURE_REEXPORT_SHIMS = new Map([
    [
        'electron/djvu/conversion.ts',
        { specifier: '@electron/features/djvu/public' },
    ],
    [
        'electron/djvu/convert.ts',
        { specifier: '@electron/features/djvu/public' },
    ],
    [
        'electron/djvu/viewing.ts',
        { specifier: '@electron/features/djvu/public' },
    ],
    [
        'electron/search/protocol.ts',
        {
            specifier: '@electron/features/search/protocol',
            typeOnly: true,
        },
    ],
]);

const NATIVE_TOOL_DOMAIN_ROOTS = [
    'electron/ocr',
    'electron/pdf',
    'electron/djvu',
];
const OCR_NATIVE_TOOL_BOUNDARY_TARGETS = new Set(`
electron/ocr/paths.ts
electron/ocr/nativeToolPaths.ts
electron/ocr/resolveOcrResourcesBase.ts
electron/ocr/worker/dpiDetection.ts
`.trim().split('\n'));

const CONTRACT_COMPATIBILITY_POLICY_IMPORTS = new Map([
    [
        '@contracts/search',
        new Set([
            'assertSafePdfSearchRegex',
            'buildPdfSearchExcerpt',
            'buildPdfSearchRegex',
            'collapseRepeatedPdfSearchPageText',
            'escapeSearchRegex',
            'findPdfSearchMatches',
            'iteratePdfSearchMatches',
            'normalizePdfSearchRequestPayload',
            'validateSearchQuery',
        ]),
    ],
    [
        '@contracts/nativePdfMutations',
        new Set([
            'normalizePdfNativeModifiedAt',
            'normalizePdfNativeMutationSet',
            'normalizePdfNativeNoteChanges',
            'normalizePdfNativeNoteTextUpdates',
            'normalizePdfNativeWorkingCopyExpectation',
        ]),
    ],
]);

const CONTRACT_COMPATIBILITY_POLICY_AGGREGATE_IMPORTS = new Set(
    Array.from(CONTRACT_COMPATIBILITY_POLICY_IMPORTS.values(), names => Array.from(names)).flat(),
);

const CONTRACT_COMPATIBILITY_POLICY_ALLOWED_ROOTS = [
    'tests',
    'packages/contracts',
];

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

function checkRetiredPdfComponentPath(filePath) {
    if (!matchesRoot(filePath, 'app/components/pdf')) {
        return null;
    }

    return createViolation({
        rule: 'retired-pdf-component-path',
        source: filePath,
        target: filePath,
        specifier: 'filesystem',
        message: 'Retired PDF components must not be recreated under app/components/pdf; use app/modules/pdf-viewer public entrypoints.',
    });
}

function checkRetiredTopLevelUsePdfFilePath(filePath) {
    if (filePath !== 'app/composables/usePdfFile.ts') {
        return null;
    }

    return createViolation({
        rule: 'retired-top-level-use-pdf-file',
        source: filePath,
        target: filePath,
        specifier: 'filesystem',
        message: 'The retired app/composables/usePdfFile.ts path must stay retired; use app/modules/workspace-shell public entrypoints.',
    });
}

function checkTopLevelPdfComposable(filePath) {
    if (
        !filePath.startsWith('app/composables/usePdf')
        || !filePath.endsWith('.ts')
        || filePath === 'app/composables/usePdfFile.ts'
    ) {
        return null;
    }

    return createViolation({
        rule: 'top-level-pdf-composable',
        source: filePath,
        target: filePath,
        specifier: 'filesystem',
        message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
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

function checkAppPagesModulePublicEntrypoint(edge) {
    if (!matchesRoot(edge.source, 'app/pages')) {
        return null;
    }

    const targetOwner = getFeatureOwner(edge.target, 'app/modules');
    if (!targetOwner) {
        return null;
    }

    const relativePath = relativeWithinOwner(edge.target, 'app/modules', targetOwner);
    if (isAllowedPublicEntrypoint(relativePath, APP_MODULE_PUBLIC_ENTRYPOINTS)) {
        return null;
    }

    return createViolation({
        rule: 'app-pages-module-deep-import',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'app/pages imports from app/modules must use module public entrypoints only.',
    });
}

function checkPlatformApiAggregateImport(edge) {
    if (edge.target !== 'packages/contracts/platformApi.ts') {
        return null;
    }
    if (PLATFORM_API_AGGREGATE_IMPORT_BOUNDARY_FILES.has(edge.source)) {
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

function checkPdfViewerEngineLayer(edge) {
    if (!matchesRoot(edge.source, PDF_VIEWER_ENGINE_ROOT) || !matchesRoot(edge.target, PDF_VIEWER_MODULE_ROOT)) {
        return null;
    }

    if (PDF_VIEWER_ENGINE_ALLOWED_TARGET_ROOTS.some(root => matchesRoot(edge.target, root))) {
        return null;
    }

    return createViolation({
        rule: 'pdf-viewer-engine-layer-back-edge',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'PDF viewer engine code must not import runtime, component, tool, or public module layers; move pure contracts/helpers into engine.',
    });
}

function isTestSource(filePath) {
    return matchesRoot(filePath, 'tests');
}

function isOcrNativeToolBoundaryOwner(filePath) {
    return matchesRoot(filePath, 'electron/ocr')
        || matchesRoot(filePath, 'electron/features/ocr');
}

function checkNativeToolsDomainImport(edge) {
    if (!matchesRoot(edge.source, 'electron/native-tools')) {
        return null;
    }
    if (!NATIVE_TOOL_DOMAIN_ROOTS.some(root => matchesRoot(edge.target, root))) {
        return null;
    }

    return createViolation({
        rule: 'native-tools-domain-import',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'Generic native-tool code must not import OCR, PDF, or DjVu domain modules.',
    });
}

function checkOcrNativeToolBoundaryImport(edge) {
    if (!OCR_NATIVE_TOOL_BOUNDARY_TARGETS.has(edge.target)) {
        return null;
    }
    if (
        isOcrNativeToolBoundaryOwner(edge.source)
        || isTestSource(edge.source)
        || matchesRoot(edge.source, 'electron/native-tools')
    ) {
        return null;
    }

    return createViolation({
        rule: 'ocr-native-tool-boundary-import',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'Non-OCR Electron code must not import OCR-owned native-tool, resource, or DPI helpers.',
    });
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hasPrivateMemberAccess(sourceText, baseName) {
    const memberGroup = ANNOTATION_STORAGE_PRIVATE_MEMBERS.map(escapeRegExp).join('|');
    const base = escapeRegExp(baseName);
    const dotAccess = new RegExp(`\\b${base}\\s*(?:\\?\\.)?\\s*\\.\\s*(?:${memberGroup})\\b`, 'u');
    const optionalAccess = new RegExp(`\\b${base}\\s*\\?\\.\\s*(?:${memberGroup})\\b`, 'u');
    const elementAccess = new RegExp(`\\b${base}\\s*(?:\\?\\.)?\\s*\\[\\s*['"](?:${memberGroup})['"]\\s*\\]`, 'u');
    return dotAccess.test(sourceText) || optionalAccess.test(sourceText) || elementAccess.test(sourceText);
}

function collectAnnotationStorageAliases(sourceText) {
    const aliases = new Set(['annotationStorage']);
    const aliasPatterns = [
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.\s*annotationStorage\b/gu,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\?\.\s*annotationStorage\b/gu,
    ];

    for (const pattern of aliasPatterns) {
        for (const match of sourceText.matchAll(pattern)) {
            if (match[1]) {
                aliases.add(match[1]);
            }
        }
    }

    return aliases;
}

function checkAnnotationStoragePrivateAccess(filePath, sourceText = '') {
    if (
        !matchesRoot(filePath, 'app')
        || ANNOTATION_STORAGE_PRIVATE_ACCESS_ALLOWED_FILES.has(filePath)
    ) {
        return [];
    }

    const aliases = collectAnnotationStorageAliases(sourceText);
    const hasPrivateAccess = Array.from(aliases).some(alias => hasPrivateMemberAccess(sourceText, alias));
    if (!hasPrivateAccess) {
        return [];
    }

    return [createViolation({
        rule: 'annotation-storage-private-access',
        source: filePath,
        target: filePath,
        specifier: 'source',
        message: 'PDF.js annotationStorage dirty-state members must be accessed through the annotation save bridge.',
    })];
}

function hasAppProductionSourceExtension(filePath) {
    return APP_PRODUCTION_SOURCE_EXTENSIONS.some(extension => filePath.endsWith(extension));
}

function isAppProductionSource(filePath) {
    return matchesRoot(filePath, 'app')
        && hasAppProductionSourceExtension(filePath)
        && !filePath.endsWith('.d.ts')
        && !filePath.endsWith('.d.mts')
        && !filePath.endsWith('.d.cts')
        && !filePath.includes('/__tests__/')
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath);
}

function isProductionAppOrElectronSource(filePath) {
    return (
        matchesRoot(filePath, 'app')
        || matchesRoot(filePath, 'electron')
    )
        && hasAppProductionSourceExtension(filePath)
        && !filePath.endsWith('.d.ts')
        && !filePath.endsWith('.d.mts')
        && !filePath.endsWith('.d.cts')
        && !filePath.includes('/__tests__/')
        && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath);
}

function isContractCompatibilityPolicyAllowedSource(filePath) {
    return CONTRACT_COMPATIBILITY_POLICY_ALLOWED_ROOTS.some(root => matchesRoot(filePath, root));
}

function stripSourceExtension(filePath) {
    return filePath.replace(/\.[cm]?[jt]sx?$/u, '');
}

function resolveSourceImportPath(sourceFile, specifier) {
    if (specifier.startsWith('@app/')) {
        return `app/${specifier.slice('@app/'.length)}`;
    }
    if (specifier.startsWith('~/') && matchesRoot(sourceFile, 'app')) {
        return `app/${specifier.slice(2)}`;
    }
    if (specifier.startsWith('~~/')) {
        return specifier.slice(3);
    }
    if (specifier.startsWith('app/')) {
        return specifier;
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier));
    }
    return null;
}

function resolvesToPlatformRuntimeHelper(sourceFile, specifier) {
    const resolvedPath = resolveSourceImportPath(sourceFile, specifier);
    return resolvedPath !== null && stripSourceExtension(resolvedPath) === PLATFORM_API_RUNTIME_HELPER_MODULE_PATH;
}

function getScriptKind(filePath, attributes = '') {
    if (attributes.includes('lang="jsx"') || attributes.includes('lang=\'jsx\'') || filePath.endsWith('.jsx')) {
        return ts.ScriptKind.JSX;
    }
    if (
        attributes.includes('lang="tsx"')
        || attributes.includes('lang=\'tsx\'')
        || filePath.endsWith('.tsx')
    ) {
        return ts.ScriptKind.TSX;
    }
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

function collectParsableSourceTexts(filePath, sourceText) {
    if (!filePath.endsWith('.vue')) {
        return [{
            sourceText,
            scriptKind: getScriptKind(filePath),
        }];
    }

    const scriptBlocks = [];
    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
    for (const match of sourceText.matchAll(scriptPattern)) {
        scriptBlocks.push({
            sourceText: match[2] ?? '',
            scriptKind: getScriptKind(filePath, match[1] ?? ''),
        });
    }
    return scriptBlocks;
}

function collectPlatformRuntimeGetterImports(filePath, sourceFile) {
    const directBindings = new Set();
    const namespaceBindings = new Set();

    sourceFile.forEachChild(node => {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
            return;
        }
        if (!resolvesToPlatformRuntimeHelper(filePath, node.moduleSpecifier.text)) {
            return;
        }

        const importClause = node.importClause;
        if (!importClause || importClause.isTypeOnly) {
            return;
        }

        const namedBindings = importClause.namedBindings;
        if (!namedBindings) {
            return;
        }

        if (ts.isNamespaceImport(namedBindings)) {
            namespaceBindings.add(namedBindings.name.text);
            return;
        }

        for (const element of namedBindings.elements) {
            if (element.isTypeOnly) {
                continue;
            }
            const importedName = element.propertyName?.text ?? element.name.text;
            if (importedName === 'getPlatformAPI') {
                directBindings.add(element.name.text);
            }
        }
    });

    return {
        directBindings,
        namespaceBindings,
    };
}

function isImportedPlatformRuntimeGetterCall(expression, directBindings, namespaceBindings) {
    if (ts.isIdentifier(expression)) {
        return directBindings.has(expression.text);
    }
    if (
        ts.isPropertyAccessExpression(expression)
        && expression.name.text === 'getPlatformAPI'
        && ts.isIdentifier(expression.expression)
    ) {
        return namespaceBindings.has(expression.expression.text);
    }
    return false;
}

function hasPlatformRuntimeGetterCall(sourceFile, directBindings, namespaceBindings) {
    let hasCall = false;

    function visit(node) {
        if (hasCall) {
            return;
        }
        if (
            ts.isCallExpression(node)
            && isImportedPlatformRuntimeGetterCall(node.expression, directBindings, namespaceBindings)
        ) {
            hasCall = true;
            return;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return hasCall;
}

function checkPlatformApiRuntimeGetterCall(filePath, sourceText = '') {
    if (
        !isAppProductionSource(filePath)
        || PLATFORM_API_RUNTIME_GETTER_ALLOWED_FILES.has(filePath)
    ) {
        return [];
    }

    const sourceBlocks = collectParsableSourceTexts(filePath, sourceText);
    for (const [
        index,
        sourceBlock,
    ] of sourceBlocks.entries()) {
        const sourceFile = ts.createSourceFile(
            `${filePath}#${index}`,
            sourceBlock.sourceText,
            ts.ScriptTarget.Latest,
            true,
            sourceBlock.scriptKind,
        );
        const {
            directBindings,
            namespaceBindings,
        } = collectPlatformRuntimeGetterImports(filePath, sourceFile);

        if (directBindings.size === 0 && namespaceBindings.size === 0) {
            continue;
        }
        if (!hasPlatformRuntimeGetterCall(sourceFile, directBindings, namespaceBindings)) {
            continue;
        }

        return [createViolation({
            rule: 'platform-api-runtime-getter',
            source: filePath,
            target: 'app/utils/platform.ts',
            specifier: '@app/utils/platform#getPlatformAPI',
            message: 'App code must use a narrow platform capability getter instead of calling getPlatformAPI() directly.',
        })];
    }

    return [];
}

function getContractCompatibilityPolicyNamesForSpecifier(specifier) {
    if (specifier === '@contracts' || specifier === '@contracts/index') {
        return CONTRACT_COMPATIBILITY_POLICY_AGGREGATE_IMPORTS;
    }
    return CONTRACT_COMPATIBILITY_POLICY_IMPORTS.get(specifier) ?? null;
}

function collectContractCompatibilityPolicyImportViolations(filePath, sourceFile) {
    const violations = [];

    sourceFile.forEachChild(node => {
        if (
            !(
                ts.isImportDeclaration(node)
                || ts.isExportDeclaration(node)
            )
            || !node.moduleSpecifier
            || !ts.isStringLiteral(node.moduleSpecifier)
        ) {
            return;
        }

        const bannedNames = getContractCompatibilityPolicyNamesForSpecifier(node.moduleSpecifier.text);
        if (!bannedNames) {
            return;
        }

        if (ts.isExportDeclaration(node)) {
            if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
                violations.push(createViolation({
                    rule: 'contract-compat-policy-import',
                    source: filePath,
                    target: node.moduleSpecifier.text,
                    specifier: '*',
                    message: 'Production app/electron code must import moved search and native PDF policy from @pdf-core or the owning Electron feature, not contract compatibility modules.',
                }));
                return;
            }

            for (const element of node.exportClause.elements) {
                const exportedName = element.propertyName?.text ?? element.name.text;
                if (!bannedNames.has(exportedName)) {
                    continue;
                }
                violations.push(createViolation({
                    rule: 'contract-compat-policy-import',
                    source: filePath,
                    target: node.moduleSpecifier.text,
                    specifier: exportedName,
                    message: 'Production app/electron code must import moved search and native PDF policy from @pdf-core or the owning Electron feature, not contract compatibility modules.',
                }));
            }
            return;
        }

        const importClause = node.importClause;
        if (!importClause || importClause.isTypeOnly) {
            return;
        }

        const namedBindings = importClause.namedBindings;
        if (!namedBindings) {
            return;
        }

        if (ts.isNamespaceImport(namedBindings)) {
            violations.push(createViolation({
                rule: 'contract-compat-policy-import',
                source: filePath,
                target: node.moduleSpecifier.text,
                specifier: '*',
                message: 'Production app/electron code must import moved search and native PDF policy from @pdf-core or the owning Electron feature, not contract compatibility modules.',
            }));
            return;
        }

        if (!ts.isNamedImports(namedBindings)) {
            return;
        }

        for (const element of namedBindings.elements) {
            if (element.isTypeOnly) {
                continue;
            }
            const importedName = element.propertyName?.text ?? element.name.text;
            if (!bannedNames.has(importedName)) {
                continue;
            }
            violations.push(createViolation({
                rule: 'contract-compat-policy-import',
                source: filePath,
                target: node.moduleSpecifier.text,
                specifier: importedName,
                message: 'Production app/electron code must import moved search and native PDF policy from @pdf-core or the owning Electron feature, not contract compatibility modules.',
            }));
        }
    });

    return violations;
}

function checkContractCompatibilityPolicyImports(filePath, sourceText = '') {
    if (
        !isProductionAppOrElectronSource(filePath)
        || isContractCompatibilityPolicyAllowedSource(filePath)
    ) {
        return [];
    }

    return collectParsableSourceTexts(filePath, sourceText).flatMap((sourceBlock, index) => {
        const sourceFile = ts.createSourceFile(
            `${filePath}#${index}`,
            sourceBlock.sourceText,
            ts.ScriptTarget.Latest,
            true,
            sourceBlock.scriptKind,
        );
        return collectContractCompatibilityPolicyImportViolations(filePath, sourceFile);
    });
}

function checkElectronLegacyFeatureReexportShim(filePath, sourceText = '') {
    const expectedShim = ELECTRON_LEGACY_FEATURE_REEXPORT_SHIMS.get(filePath);
    if (!expectedShim) {
        return [];
    }

    const typeToken = expectedShim.typeOnly ? 'type ' : '';
    const expectedSourceText = `export ${typeToken}* from '${expectedShim.specifier}';\n`;
    const normalizedSourceText = sourceText.replaceAll('\r\n', '\n');
    if (normalizedSourceText === expectedSourceText) {
        return [];
    }

    return [createViolation({
        rule: 'electron-legacy-feature-reexport-shim',
        source: filePath,
        target: filePath,
        specifier: 'source',
        message: 'Legacy Electron feature shims must stay one-line re-exports to their feature entrypoint.',
    })];
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

    if (!matchesRoot(source, boundaryRule.sourceRoot) || !matchesRoot(target, boundaryRule.targetRoot)) {
        return null;
    }
    if (
        boundaryRule.rule === 'scripts-to-app'
        && SCRIPTS_TO_APP_ALLOWED_EDGES.has(`${source} -> ${target}`)
    ) {
        return null;
    }

    return createViolation({
        rule: boundaryRule.rule,
        source,
        target,
        specifier,
        message: boundaryRule.message,
    });
}

function checkPackageLayerRule(edge, layerRule) {
    if (!matchesRoot(edge.source, layerRule.sourceRoot) || !matchesRoot(edge.target, 'packages')) {
        return null;
    }
    if (layerRule.allowedTargetRoots.some(root => matchesRoot(edge.target, root))) {
        return null;
    }

    return createViolation({
        rule: layerRule.rule,
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: layerRule.message,
    });
}

function checkPackageReverseEdge(edge) {
    if (
        !matchesRoot(edge.source, 'packages')
        || matchesRoot(edge.source, 'packages/contracts')
        || !matchesRoot(edge.target, 'packages/contracts')
    ) {
        return null;
    }
    if (
        matchesRoot(edge.source, 'packages/pdf-core')
        || matchesRoot(edge.source, 'packages/release-selection')
    ) {
        return null;
    }

    return createViolation({
        rule: 'packages-contracts-reverse-edge',
        source: edge.source,
        target: edge.target,
        specifier: edge.specifier,
        message: 'Only approved leaf packages may depend on contracts; do not add reverse package edges into contracts.',
    });
}

function checkPackageLayer(edge) {
    return [
        ...collectViolationsFromRules(edge, PACKAGE_LAYER_RULES, checkPackageLayerRule),
        checkPackageReverseEdge(edge),
    ].filter(Boolean);
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
        ...checkPackageLayer(edge),
        ...collectViolationsFromRules(edge, FEATURE_BOUNDARY_RULES, checkFeatureBoundaryRule),
        ...collectViolationsFromRules(edge, PUBLIC_ONLY_INTERNAL_ENTRYPOINTS, checkPublicOnlyInternalEntrypoint),
        checkAppPagesModulePublicEntrypoint(edge),
        checkPlatformApiAggregateImport(edge),
        checkNativeToolsDomainImport(edge),
        checkOcrNativeToolBoundaryImport(edge),
        checkElectronFeatureMainPrivacy(edge),
        checkPdfViewerEngineLayer(edge),
        ...checkAnnotationDependencyEdge(edge),
    ].filter(Boolean);
}

function checkNode(filePath) {
    return [
        checkRetiredPdfComponentPath(filePath),
        checkRetiredTopLevelUsePdfFilePath(filePath),
        checkTopLevelPdfComposable(filePath),
        checkComponentDirectoryFilePlacement(filePath),
    ].filter(Boolean);
}

function checkSource(filePath, sourceText) {
    return [
        ...checkAnnotationStoragePrivateAccess(filePath, sourceText),
        ...checkPlatformApiRuntimeGetterCall(filePath, sourceText),
        ...checkContractCompatibilityPolicyImports(filePath, sourceText),
        ...checkElectronLegacyFeatureReexportShim(filePath, sourceText),
    ];
}

export function checkArchitectureBoundaryEdge(edge) {
    return checkEdge(edge);
}

export function checkArchitectureBoundaryNode(filePath) {
    return checkNode(filePath);
}

export function checkArchitectureBoundarySource(filePath, sourceText) {
    return checkSource(filePath, sourceText);
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

function collectRootsFromArgv(argv, {projectRoot}) {
    const roots = parseArchitectureRootsArg(argv);
    if (roots) {
        return roots;
    }
    return parseArchitectureScopeArg(argv) === 'focused'
        ? getFocusedArchitectureRoots({ projectRoot })
        : null;
}

async function run() {
    const projectRoot = process.cwd();
    const roots = collectRootsFromArgv(process.argv.slice(2), { projectRoot });
    const graph = await buildDependencyGraph({
        projectRoot,
        ...(roots === null ? {} : {roots}),
    });

    const sourceViolations = (
        await Promise.all(graph.nodes.map(async node => {
            const sourceText = await fs.readFile(path.join(process.cwd(), node.file), 'utf8');
            return checkSource(node.file, sourceText);
        }))
    ).flat();

    const violations = [
        ...graph.edges.flatMap(checkEdge),
        ...graph.nodes.flatMap(node => checkNode(node.file)),
        ...sourceViolations,
        ...checkAnnotationDependencyGraph(graph).violations,
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
