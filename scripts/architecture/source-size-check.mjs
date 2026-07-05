#!/usr/bin/env node

import {
    readdir,
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SOURCE_SIZE_THRESHOLD = 1200;

export const DEFAULT_SOURCE_SIZE_ROOTS = [
    'app',
    'electron',
    'scripts',
    'server',
    'packages/contracts',
    'packages/pdf-core',
    'packages/electron-worker-bundles',
    'packages/i18n-core',
    'packages/i18n-app',
    'packages/release-selection',
];

const SOURCE_EXTENSIONS = new Set([
    '.cjs',
    '.js',
    '.mjs',
    '.ts',
    '.tsx',
    '.vue',
]);

const EXCLUDED_PATH_SEGMENTS = new Set([
    '.nuxt',
    '.output',
    '.tmp',
    '.vercel',
    '__fixtures__',
    '__snapshots__',
    '__tests__',
    'coverage',
    'dist',
    'e2e',
    'fixtures',
    'node_modules',
    'playwright-report',
    'snapshots',
    'test-results',
    'tests',
]);

export const SOURCE_SIZE_ALLOWLIST = {
    'app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageScroll.ts': {
        maxLines: 2086,
        reason: 'transitional PDF navigation controller facade after single-page scroll geometry extraction',
        stage: 'Worker 2/Stage 5 - Single-page scroll geometry extraction',
    },
    'app/modules/agent-panel/components/AgentAssistantPanel.vue': {
        maxLines: 919,
        reason: 'assistant panel entrypoint after controller ownership extraction',
        stage: 'Worker 2/Stage 2 - Assistant panel controller split',
    },
    'app/modules/agent-panel/composables/useAgentAssistantPanelController.ts': {
        maxLines: 1201,
        reason: 'transitional assistant panel controller after renderer bridge startup and selection-state hardening',
        stage: 'Second-pass assistant panel controller integration',
    },
    'app/modules/pdf-viewer/components/PdfThumbnails.vue': {
        maxLines: 1105,
        reason: 'transitional PDF thumbnail UI/layout hotspot after render orchestration extraction',
        stage: 'Finding 9 Stage A - PDF thumbnail render orchestration extraction',
    },
    'electron/features/agent/codexAssistant.ts': {
        maxLines: 1384,
        reason: 'transitional Electron assistant backend facade after session store and runtime lifecycle extraction',
        stage: 'Worker 2/Stage 1 - Assistant backend session/runtime split',
    },
    'app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController.ts': {
        maxLines: 458,
        reason: 'transitional workspace save orchestration hotspot',
        stage: 'Finding 4 Stage D - Save controller port alignment',
    },
    'app/modules/djvu-viewer/components/DjvuViewer.vue': {
        maxLines: 527,
        reason: 'transitional DjVu viewer UI shell after preview runtime, scroll orchestration, and viewer-owned initial placeholder extraction',
        stage: 'Finding 9 Stage B - DjVu preview runtime and scroll controller extraction',
    },
    'scripts/electron-run/sessionManager.ts': {
        maxLines: 1312,
        reason: 'transitional Electron dev session manager hotspot',
        stage: 'Future Electron run/session extraction',
    },
    'scripts/diagnostics/pdfNavigationBlinkTrace.ts': {
        maxLines: 1730,
        reason: 'transitional PDF navigation diagnostic hotspot',
        stage: 'Worker 6 - Diagnostic trace analysis extraction',
    },
    'app/modules/workspace-shell/components/DocumentWorkspace.vue': {
        maxLines: 1625,
        reason: 'transitional workspace component hotspot after viewer adapter binding extraction',
        stage: 'Stage S - viewer adapter interface',
    },
    'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue': {
        maxLines: 1033,
        reason: 'transitional deferred workspace host hotspot',
        stage: 'Future workspace host extraction',
    },
    'app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer.ts': {
        maxLines: 1340,
        reason: 'transitional PDF annotation layer renderer hotspot',
        stage: 'Future PDF rendering extraction',
    },
    'app/platform/browser/browserDocumentRepository.ts': {
        maxLines: 1236,
        reason: 'transitional browser document repository hotspot after persistence and mutation guard changes',
        stage: 'Future browser document repository extraction',
    },
    'app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer.ts': {
        maxLines: 1262,
        reason: 'transitional PDF text layer renderer hotspot',
        stage: 'Future PDF rendering extraction',
    },
    'electron/ocr/jobManager.ts': {
        maxLines: 1175,
        reason: 'OCR job manager facade after worker lifecycle extraction',
        stage: 'Worker 2/Stage 3 - OCR job manager lifecycle split',
    },
    'app/modules/workspace-shell/components/AppShellRoot.vue': {
        maxLines: 1045,
        reason: 'transitional app shell root hotspot',
        stage: 'Future workspace shell extraction',
    },
    'app/modules/workspace-shell/agent/useDocumentWorkspaceAgent.ts': {
        maxLines: 1069,
        reason: 'transitional document workspace agent hotspot',
        stage: 'Future workspace agent extraction',
    },
    'app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue': {
        maxLines: 1221,
        reason: 'transitional workspace annotation overlay hotspot',
        stage: 'Future workspace annotation extraction',
    },
    'electron/features/agent/mcp/mcpServerCore.ts': {
        maxLines: 1062,
        reason: 'transitional agent MCP server core hotspot',
        stage: 'Future MCP server core extraction',
    },
    'scripts/architecture/boundary-check.mjs': {
        maxLines: 1266,
        reason: 'transitional architecture boundary checker after scripts-to-app diagnostics and package-layer policy expansion',
        stage: 'Second-pass architecture boundary enforcement',
    },
};

export function normalizePath(filePath) {
    return filePath.replaceAll('\\', '/').split(path.sep).join('/').replace(/^\.\//, '');
}

function hasExcludedSegment(filePath) {
    return normalizePath(filePath)
        .split('/')
        .some(segment => EXCLUDED_PATH_SEGMENTS.has(segment));
}

function isExcludedSourcePath(filePath) {
    const normalizedPath = normalizePath(filePath);
    return hasExcludedSegment(normalizedPath)
        || normalizedPath.startsWith('app/assets/css/vendor/')
        || normalizedPath.startsWith('packages/i18n-app/messages/')
        || normalizedPath.includes('/generated/')
        || normalizedPath.includes('/vendor/');
}

export function shouldScanSourcePath(filePath) {
    const normalizedPath = normalizePath(filePath);
    return SOURCE_EXTENSIONS.has(path.extname(normalizedPath))
        && !isExcludedSourcePath(normalizedPath);
}

export function countPhysicalLines(text) {
    if (text.length === 0) {
        return 0;
    }

    const lines = text.split(/\r\n|\r|\n/);
    return /(?:\r\n|\r|\n)$/.test(text) ? lines.length - 1 : lines.length;
}

export function checkSourceFileSize({
    filePath,
    lineCount,
    threshold = DEFAULT_SOURCE_SIZE_THRESHOLD,
    allowlist = SOURCE_SIZE_ALLOWLIST,
}) {
    const normalizedPath = normalizePath(filePath);
    if (!shouldScanSourcePath(normalizedPath)) {
        return null;
    }

    const allowlistEntry = allowlist[normalizedPath];
    if (allowlistEntry) {
        if (lineCount < allowlistEntry.maxLines) {
            return {
                rule: 'source-size-allowlist-budget-slack',
                file: normalizedPath,
                lineCount,
                maxLines: allowlistEntry.maxLines,
                message: `Allowlisted source file shrank below its ${allowlistEntry.maxLines} line budget; lower the budget to ${lineCount} lines.`,
                reason: allowlistEntry.reason,
                stage: allowlistEntry.stage,
            };
        }

        if (lineCount === allowlistEntry.maxLines) {
            return null;
        }

        return {
            rule: 'source-size-allowlist-growth',
            file: normalizedPath,
            lineCount,
            maxLines: allowlistEntry.maxLines,
            message: `Allowlisted source file grew beyond its ${allowlistEntry.maxLines} line budget.`,
            reason: allowlistEntry.reason,
            stage: allowlistEntry.stage,
        };
    }

    if (lineCount <= threshold) {
        return null;
    }

    return {
        rule: 'source-size-threshold',
        file: normalizedPath,
        lineCount,
        maxLines: threshold,
        message: `Source file exceeds the ${threshold} line threshold and is not allowlisted.`,
    };
}

async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function collectSourceFiles({
    projectRoot,
    roots,
}) {
    const sourceFiles = [];

    async function visit(relativePath) {
        const absolutePath = path.join(projectRoot, relativePath);
        const entries = await readdir(absolutePath, { withFileTypes: true });
        for (const entry of entries) {
            const entryRelativePath = normalizePath(path.join(relativePath, entry.name));
            if (entry.isDirectory()) {
                if (!isExcludedSourcePath(entryRelativePath)) {
                    await visit(entryRelativePath);
                }
                continue;
            }

            if (entry.isFile() && shouldScanSourcePath(entryRelativePath)) {
                sourceFiles.push(entryRelativePath);
            }
        }
    }

    for (const root of roots.map(normalizePath)) {
        if (await pathExists(path.join(projectRoot, root))) {
            await visit(root);
        }
    }

    return sourceFiles.sort((a, b) => a.localeCompare(b));
}

export async function checkSourceFileSizes({
    projectRoot,
    roots = DEFAULT_SOURCE_SIZE_ROOTS,
    threshold = DEFAULT_SOURCE_SIZE_THRESHOLD,
    allowlist = SOURCE_SIZE_ALLOWLIST,
}) {
    const sourceFiles = await collectSourceFiles({
        projectRoot,
        roots,
    });
    const violations = [];

    for (const filePath of sourceFiles) {
        const text = await readFile(path.join(projectRoot, filePath), 'utf8');
        const violation = checkSourceFileSize({
            filePath,
            lineCount: countPhysicalLines(text),
            threshold,
            allowlist,
        });
        if (violation) {
            violations.push(violation);
        }
    }

    return {
        scannedFiles: sourceFiles.length,
        violations,
    };
}

function collectRootsFromArgv(argv) {
    const rootArg = argv.find(argument => argument.startsWith('--roots='));
    if (!rootArg) {
        return DEFAULT_SOURCE_SIZE_ROOTS;
    }

    return rootArg
        .slice('--roots='.length)
        .split(',')
        .map(value => normalizePath(value.trim()))
        .filter(Boolean)
        .filter(root => !path.isAbsolute(root));
}

function collectThresholdFromArgv(argv) {
    const thresholdArg = argv.find(argument => argument.startsWith('--threshold='));
    if (!thresholdArg) {
        return DEFAULT_SOURCE_SIZE_THRESHOLD;
    }

    const threshold = Number.parseInt(thresholdArg.slice('--threshold='.length), 10);
    if (!Number.isFinite(threshold) || threshold <= 0) {
        throw new Error(`Invalid --threshold value: ${thresholdArg}`);
    }

    return threshold;
}

function formatViolations(violations) {
    return violations.map((violation, index) => {
        const serial = index + 1;
        return [
            `${serial}. [${violation.rule}] ${violation.message}`,
            `   file: ${violation.file}`,
            `   lines: ${violation.lineCount}`,
            `   budget: ${violation.maxLines}`,
            ...(violation.stage ? [`   stage: ${violation.stage}`] : []),
            ...(violation.reason ? [`   reason: ${violation.reason}`] : []),
        ].join('\n');
    }).join('\n');
}

async function run() {
    const argv = process.argv.slice(2);
    const roots = collectRootsFromArgv(argv);
    const threshold = collectThresholdFromArgv(argv);
    const result = await checkSourceFileSizes({
        projectRoot: process.cwd(),
        roots,
        threshold,
    });

    if (result.violations.length > 0) {
        console.error('Source-size architecture check failed.');
        console.error(formatViolations(result.violations));
        process.exit(1);
    }

    console.log(`Source-size architecture check passed (${result.scannedFiles} source files scanned).`);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    run().catch(error => {
        console.error('[source-size-check] Unexpected failure.');
        console.error(error);
        process.exit(1);
    });
}
