import {isRecord} from '@contracts/runtimeGuards';
import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_SUMMARY_PATH = 'coverage/coverage-summary.json';

export interface ILineCoverageSummary {
    covered: number;
    total: number;
}

export interface IZeroExecutionCoverageResult {
    missingFiles: string[];
    passed: boolean;
    targetFileCount: number;
    zeroExecutionFiles: string[];
}

function assertFiniteNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }
    return value;
}

function normalizeCoveragePath(filePath: string, projectRoot: string) {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '');
    return path.isAbsolute(filePath) && normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath.replace(/^\.\//u, '');
}

export function parseLineCoverageSummary(source: string, projectRoot = process.cwd()) {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
        throw new Error('Coverage summary must be a JSON object.');
    }

    const files = new Map<string, ILineCoverageSummary>();
    for (const [
        filePath,
        rawMetrics,
    ] of Object.entries(parsed)) {
        if (filePath === 'total') {
            continue;
        }
        if (!isRecord(rawMetrics) || !isRecord(rawMetrics.lines)) {
            throw new Error(`Coverage summary ${filePath}.lines must be an object.`);
        }
        files.set(normalizeCoveragePath(filePath, projectRoot), {
            covered: assertFiniteNumber(rawMetrics.lines.covered, `Coverage summary ${filePath}.lines.covered`),
            total: assertFiniteNumber(rawMetrics.lines.total, `Coverage summary ${filePath}.lines.total`),
        });
    }
    return files;
}

export function isZeroExecutionTripwireTarget(filePath: string) {
    const normalized = filePath.replaceAll('\\', '/');
    if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) {
        return false;
    }
    if (normalized.startsWith('electron/platform-ipc/') || normalized.startsWith('packages/contracts/')) {
        return true;
    }

    const basename = path.posix.basename(normalized);
    return basename.endsWith('.worker.ts')
        || basename.endsWith('Worker.ts')
        || basename === 'worker.ts'
        || normalized === 'electron/ocr/worker/main.ts';
}

async function collectProductionTypeScriptFiles(root: string, relativeDirectory: string): Promise<string[]> {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, {withFileTypes: true});
    const files: string[] = [];

    for (const entry of entries) {
        const relativePath = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectProductionTypeScriptFiles(root, relativePath));
        } else if (entry.isFile() && isZeroExecutionTripwireTarget(relativePath)) {
            files.push(relativePath);
        }
    }
    return files;
}

export async function collectZeroExecutionTripwireTargets(projectRoot = process.cwd()) {
    const roots = [
        'app',
        'electron',
        'packages',
    ];
    const files = (await Promise.all(roots.map(root => collectProductionTypeScriptFiles(projectRoot, root)))).flat();
    return files.sort((left, right) => left.localeCompare(right));
}

export function checkZeroExecutionCoverage(
    targetFiles: readonly string[],
    coverageFiles: ReadonlyMap<string, ILineCoverageSummary>,
): IZeroExecutionCoverageResult {
    const missingFiles: string[] = [];
    const zeroExecutionFiles: string[] = [];

    for (const filePath of targetFiles) {
        const coverage = coverageFiles.get(filePath);
        if (coverage === undefined) {
            missingFiles.push(filePath);
        } else if (coverage.total > 0 && coverage.covered === 0) {
            zeroExecutionFiles.push(filePath);
        }
    }

    return {
        missingFiles,
        passed: missingFiles.length === 0 && zeroExecutionFiles.length === 0,
        targetFileCount: targetFiles.length,
        zeroExecutionFiles,
    };
}

export function formatZeroExecutionCoverageResult(result: IZeroExecutionCoverageResult) {
    const lines = [result.passed
        ? `Zero-execution coverage tripwire passed for ${result.targetFileCount} production files.`
        : `Zero-execution coverage tripwire failed for ${result.targetFileCount} production files.`];

    if (result.missingFiles.length > 0) {
        lines.push('Files missing from the coverage report (check coverage.include):');
        lines.push(...result.missingFiles.map(file => `  ${file}`));
    }
    if (result.zeroExecutionFiles.length > 0) {
        lines.push('Production files with zero executed lines:');
        lines.push(...result.zeroExecutionFiles.map(file => `  ${file}`));
    }
    return lines.join('\n');
}

export async function runZeroExecutionCoverage(options: {
    projectRoot?: string;
    summaryPath?: string;
} = {}) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const summaryPath = path.resolve(projectRoot, options.summaryPath ?? DEFAULT_SUMMARY_PATH);
    const [
        summary,
        targetFiles,
    ] = await Promise.all([
        readFile(summaryPath, 'utf8'),
        collectZeroExecutionTripwireTargets(projectRoot),
    ]);
    const result = checkZeroExecutionCoverage(
        targetFiles,
        parseLineCoverageSummary(summary, projectRoot),
    );
    console.log(formatZeroExecutionCoverageResult(result));
    if (!result.passed) {
        process.exitCode = 1;
    }
    return result;
}

const isEntryPoint = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
    await runZeroExecutionCoverage();
}
