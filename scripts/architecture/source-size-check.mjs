#!/usr/bin/env node

import {
    readdir,
    readFile,
    stat,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArchitectureRootsArg } from './architectureCliArgs.mjs';
import { getFocusedArchitectureRoots } from '../workspace-roots.mjs';

export const DEFAULT_SOURCE_SIZE_THRESHOLD = 1200;

export const DEFAULT_SOURCE_SIZE_ROOTS = getFocusedArchitectureRoots();

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
    'app/modules/agent-panel/components/AgentAssistantPanel.vue': {
        maxLines: 789,
        reason: 'assistant panel entrypoint after extracting turn status and markdown segment rendering',
        stage: 'Assistant overhaul - presentation component extraction',
    },
    'app/modules/agent-panel/composables/useAgentAssistantPanelController.ts': {
        maxLines: 1159,
        reason: 'assistant controller after clipboard/message-cache and image-composer ownership extraction',
        stage: 'Static audit Stage 15 - assistant controller domain extraction',
    },
    'app/modules/pdf-viewer/components/PdfThumbnails.vue': {
        maxLines: 930,
        reason: 'PDF thumbnail augmentation after shared rail, chrome, geometry, and component-contract extraction',
        stage: 'Document-format parity - shared thumbnail architecture',
    },
    'app/modules/native-pdf-viewer/components/NativePdfViewer.vue': {
        maxLines: 1312,
        reason: 'native PDF viewer after committed-surface ownership and page-source lifecycle hardening',
        stage: 'Viewer core follow-up - native PDF presentation extraction',
    },
    'electron/features/agent/codexAssistant.ts': {
        maxLines: 1331,
        reason: 'transitional Electron assistant backend facade after session store and runtime lifecycle extraction',
        stage: 'Worker 2/Stage 1 - Assistant backend session/runtime split',
    },
    'app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController.ts': {
        maxLines: 441,
        reason: 'transitional workspace save orchestration hotspot',
        stage: 'Finding 4 Stage D - Save controller port alignment',
    },
    'scripts/diagnostics/pdfNavigationBlinkTrace.ts': {
        maxLines: 1719,
        reason: 'transitional PDF navigation diagnostic hotspot',
        stage: 'Worker 6 - Diagnostic trace analysis extraction',
    },
    'app/modules/workspace-shell/components/DocumentWorkspace.vue': {
        maxLines: 1496,
        reason: 'workspace component after deferred-search and component-binding extraction',
        stage: 'Static audit Stage 15 - workspace binding extraction',
    },
    'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue': {
        maxLines: 1409,
        reason: 'page-source feature pack after shared chassis, retry, and committed-surface lifecycle integration',
        stage: 'Viewer core follow-up - page-source controller extraction',
    },
    'app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer.ts': {
        maxLines: 1297,
        reason: 'annotation renderer after hidden-annotation policy and failure tracking extraction',
        stage: 'Static audit Stage 15 - annotation renderer domain extraction',
    },
    'app/platform/browser/browserDocumentRepository.ts': {
        maxLines: 1207,
        reason: 'browser repository after persistence fallback and memory-only source lifetime hardening',
        stage: 'Browser resilience overhaul - transient source retention',
    },
    'app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer.ts': {
        maxLines: 1264,
        reason: 'transitional PDF text layer renderer hotspot',
        stage: 'Future PDF rendering extraction',
    },
    'app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts': {
        maxLines: 1258,
        reason: 'PDF feature controller after render-demand and prepared opening-frame authority integration',
        stage: 'Viewer core follow-up - opening and render-demand orchestration extraction',
    },
    'electron/ocr/jobManager.ts': {
        maxLines: 993,
        reason: 'OCR job manager facade after request-work estimation extraction',
        stage: 'Static audit Stage 15 - OCR admission calculation extraction',
    },
    'app/modules/workspace-shell/components/AppShellRoot.vue': {
        maxLines: 918,
        reason: 'app shell orchestration after scoped presentation styles were extracted',
        stage: 'Static audit Stage 15 - app shell style extraction',
    },
    'app/modules/workspace-shell/agent/useDocumentWorkspaceAgent.ts': {
        maxLines: 1081,
        reason: 'transitional document workspace agent hotspot',
        stage: 'Future workspace agent extraction',
    },
    'app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue': {
        maxLines: 1176,
        reason: 'transitional workspace annotation overlay hotspot',
        stage: 'Future workspace annotation extraction',
    },
    'electron/features/agent/mcp/mcpServerCore.ts': {
        maxLines: 979,
        reason: 'agent MCP server core after result encoding and public option-contract extraction',
        stage: 'Static audit Stage 15 - MCP core contract extraction',
    },
    'scripts/architecture/boundary-check.mjs': {
        maxLines: 1232,
        reason: 'architecture boundary checker after runtime/tool policy extraction',
        stage: 'Static audit Stage 15 - boundary policy extraction',
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
    roots = getFocusedArchitectureRoots({ projectRoot }),
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

function collectRootsFromArgv(argv, {projectRoot}) {
    return parseArchitectureRootsArg(argv)
        ?? getFocusedArchitectureRoots({ projectRoot });
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
    const projectRoot = process.cwd();
    const argv = process.argv.slice(2);
    const roots = collectRootsFromArgv(argv, { projectRoot });
    const threshold = collectThresholdFromArgv(argv);
    const result = await checkSourceFileSizes({
        projectRoot,
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
