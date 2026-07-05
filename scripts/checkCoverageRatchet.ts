import {isRecord} from '@contracts/runtimeGuards';
import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonObject } from 'type-fest';

const COVERAGE_METRICS = [
    'statements',
    'branches',
    'functions',
    'lines',
] as const;

const DEFAULT_BASELINE_PATH = 'coverage-baseline.json';
const DEFAULT_SUMMARY_PATH = 'coverage/coverage-summary.json';
const DEFAULT_TOLERANCE_PERCENTAGE_POINTS = 0.5;
const BASELINE_VERSION = 1;

export interface ICoverageAreaDefinition { include: string[] }

export const DEFAULT_COVERAGE_AREAS = {
    'electron-djvu-feature': {include: ['electron/features/djvu/']},
    'electron-core': {include: ['electron/']},
    'electron-ocr': {include: ['electron/ocr/']},
    'electron-updates': {include: ['electron/updates']},
    'pdf-viewer-engine': {include: ['app/modules/pdf-viewer/engine/']},
    'pdf-viewer-navigation': {include: ['app/modules/pdf-viewer/runtime/navigation/']},
    'pdf-viewer-rendering': {include: ['app/modules/pdf-viewer/runtime/rendering/']},
    'release-scripts': {include: ['scripts/release/']},
    'workspace-shell-composables': {include: ['app/modules/workspace-shell/composables/']},
} satisfies Record<string, ICoverageAreaDefinition>;

export type TCoverageMetric = typeof COVERAGE_METRICS[number];

export interface ICoverageMetricSummary {
    covered: number;
    pct: number;
    skipped: number;
    total: number;
}

export interface ICoverageFileSnapshot {
    filePath: string;
    metrics: Record<TCoverageMetric, ICoverageMetricSummary>;
}

export interface ICoverageAreaSnapshot {
    fileCount: number;
    metrics: Record<TCoverageMetric, ICoverageMetricSummary>;
}

export interface ICoverageSnapshot {
    files: ICoverageFileSnapshot[];
    metrics: Record<TCoverageMetric, ICoverageMetricSummary>;
}

export interface ICoverageAreaBaseline extends ICoverageAreaDefinition {
    fileCount: number;
    metrics: Record<TCoverageMetric, number>;
}

export interface ICoverageBaseline {
    areas?: Record<string, ICoverageAreaBaseline>;
    metrics: Record<TCoverageMetric, number>;
    tolerancePercentagePoints: number;
    version: typeof BASELINE_VERSION;
}

export interface ICoverageComparison {
    baselinePct: number;
    currentPct: number;
    deltaPercentagePoints: number;
    metric: TCoverageMetric;
    scope: 'area' | 'total';
    area?: string;
    status: 'improved' | 'missing' | 'regressed' | 'unchanged' | 'within-tolerance';
}

export interface ICoverageRatchetResult {
    comparisons: ICoverageComparison[];
    passed: boolean;
    tolerancePercentagePoints: number;
}

interface IParsedArgs {
    baselinePath: string;
    summaryPath: string;
    tolerancePercentagePoints?: number;
    updateBaseline: boolean;
}


function assertNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }

    return value;
}

function assertStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be a non-empty string array.`);
    }

    return value.map((item) => {
        if (typeof item !== 'string' || item.length === 0) {
            throw new Error(`${label} must be a non-empty string array.`);
        }

        return item;
    });
}

function parseJsonObject(source: string, label: string): JsonObject {
    const parsed = JSON.parse(source) as unknown;

    if (!isRecord(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    return parsed as JsonObject;
}

function parseCoverageMetricSummary(rawMetric: unknown, label: string): ICoverageMetricSummary {
    if (!isRecord(rawMetric)) {
        throw new Error(`${label} must be an object.`);
    }

    return {
        covered: assertNumber(rawMetric.covered, `${label}.covered`),
        pct: assertNumber(rawMetric.pct, `${label}.pct`),
        skipped: assertNumber(rawMetric.skipped, `${label}.skipped`),
        total: assertNumber(rawMetric.total, `${label}.total`),
    };
}

function parseCoverageMetricSummaryRecord(
    rawMetrics: unknown,
    label: string,
): Record<TCoverageMetric, ICoverageMetricSummary> {
    if (!isRecord(rawMetrics)) {
        throw new Error(`${label} must be an object.`);
    }

    const metrics = {} as Record<TCoverageMetric, ICoverageMetricSummary>;

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = parseCoverageMetricSummary(rawMetrics[metric], `${label}.${metric}`);
    }

    return metrics;
}

function parseCoverageBaselineMetricRecord(
    rawMetrics: unknown,
    label: string,
): Record<TCoverageMetric, number> {
    if (!isRecord(rawMetrics)) {
        throw new Error(`${label} must be an object.`);
    }

    const metrics = {} as Record<TCoverageMetric, number>;

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = assertNumber(rawMetrics[metric], `${label}.${metric}`);
    }

    return metrics;
}

function normalizeCoverageFilePath(filePath: string, projectRoot: string) {
    const normalizedPath = filePath.replaceAll('\\', '/');
    const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/$/u, '');

    if (path.isAbsolute(filePath) && normalizedPath.startsWith(`${normalizedRoot}/`)) {
        return normalizedPath.slice(normalizedRoot.length + 1);
    }

    return normalizedPath.replace(/^\.\//u, '');
}

export function parseCoverageSummary(source: string, projectRoot = process.cwd()): ICoverageSnapshot {
    const parsed = parseJsonObject(source, 'Coverage summary');
    const metrics = parseCoverageMetricSummaryRecord(parsed.total, 'Coverage summary total');
    const files: ICoverageFileSnapshot[] = [];

    for (const [
        filePath,
        rawFileMetrics,
    ] of Object.entries(parsed)) {
        if (filePath === 'total') {
            continue;
        }

        files.push({
            filePath: normalizeCoverageFilePath(filePath, projectRoot),
            metrics: parseCoverageMetricSummaryRecord(rawFileMetrics, `Coverage summary ${filePath}`),
        });
    }

    files.sort((left, right) => left.filePath.localeCompare(right.filePath));

    return {
        files,
        metrics,
    };
}

export function parseCoverageBaseline(source: string): ICoverageBaseline {
    const parsed = parseJsonObject(source, 'Coverage baseline');

    if (parsed.version !== BASELINE_VERSION) {
        throw new Error(`Coverage baseline version must be ${BASELINE_VERSION}.`);
    }

    const metrics = parseCoverageBaselineMetricRecord(parsed.metrics, 'Coverage baseline metrics');
    const areasObject = parsed.areas;
    const areas: Record<string, ICoverageAreaBaseline> = {};

    if (areasObject !== undefined) {
        if (!isRecord(areasObject)) {
            throw new Error('Coverage baseline areas must be an object.');
        }

        for (const [
            areaName,
            rawArea,
        ] of Object.entries(areasObject)) {
            if (!isRecord(rawArea)) {
                throw new Error(`Coverage baseline areas.${areaName} must be an object.`);
            }

            areas[areaName] = {
                fileCount: assertNumber(rawArea.fileCount, `Coverage baseline areas.${areaName}.fileCount`),
                include: assertStringArray(rawArea.include, `Coverage baseline areas.${areaName}.include`),
                metrics: parseCoverageBaselineMetricRecord(
                    rawArea.metrics,
                    `Coverage baseline areas.${areaName}.metrics`,
                ),
            };
        }
    }

    return {
        ...(Object.keys(areas).length > 0 ? { areas } : {}),
        metrics,
        tolerancePercentagePoints: assertNumber(
            parsed.tolerancePercentagePoints,
            'Coverage baseline tolerancePercentagePoints',
        ),
        version: BASELINE_VERSION,
    };
}

export function createCoverageBaseline(
    snapshot: ICoverageSnapshot,
    tolerancePercentagePoints = DEFAULT_TOLERANCE_PERCENTAGE_POINTS,
    areas: Record<string, ICoverageAreaDefinition> = DEFAULT_COVERAGE_AREAS,
): ICoverageBaseline {
    const metrics = {} as Record<TCoverageMetric, number>;
    const areaBaselines: Record<string, ICoverageAreaBaseline> = {};

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = snapshot.metrics[metric].pct;
    }

    for (const [
        areaName,
        areaDefinition,
    ] of Object.entries(areas)
            .sort(([left], [right]) => left.localeCompare(right))) {
        const areaSnapshot = aggregateCoverageArea(snapshot, areaDefinition);
        if (areaSnapshot.fileCount === 0) {
            continue;
        }

        const areaMetrics = {} as Record<TCoverageMetric, number>;
        for (const metric of COVERAGE_METRICS) {
            areaMetrics[metric] = areaSnapshot.metrics[metric].pct;
        }

        areaBaselines[areaName] = {
            fileCount: areaSnapshot.fileCount,
            include: [...areaDefinition.include],
            metrics: areaMetrics,
        };
    }

    return {
        ...(Object.keys(areaBaselines).length > 0 ? { areas: areaBaselines } : {}),
        metrics,
        tolerancePercentagePoints,
        version: BASELINE_VERSION,
    };
}

export function stringifyCoverageBaseline(baseline: ICoverageBaseline) {
    const payload: {
        areas?: Record<string, {
            fileCount: number;
            include: string[];
            metrics: Record<TCoverageMetric, number>;
        }>;
        metrics: Record<TCoverageMetric, number>;
        tolerancePercentagePoints: number;
        version: typeof BASELINE_VERSION;
    } = {
        version: baseline.version,
        tolerancePercentagePoints: baseline.tolerancePercentagePoints,
        metrics: {
            statements: baseline.metrics.statements,
            branches: baseline.metrics.branches,
            functions: baseline.metrics.functions,
            lines: baseline.metrics.lines,
        },
    };

    if (baseline.areas) {
        payload.areas = {};
        for (const [
            areaName,
            area,
        ] of Object.entries(baseline.areas)
                .sort(([left], [right]) => left.localeCompare(right))) {
            payload.areas[areaName] = {
                include: [...area.include],
                fileCount: area.fileCount,
                metrics: {
                    statements: area.metrics.statements,
                    branches: area.metrics.branches,
                    functions: area.metrics.functions,
                    lines: area.metrics.lines,
                },
            };
        }
    }

    return `${JSON.stringify({
        version: payload.version,
        tolerancePercentagePoints: payload.tolerancePercentagePoints,
        metrics: payload.metrics,
        ...(payload.areas ? {areas: payload.areas} : {}),
    }, null, 2)}\n`;
}

function createEmptyMetricSummary(): ICoverageMetricSummary {
    return {
        covered: 0,
        pct: 100,
        skipped: 0,
        total: 0,
    };
}

function calculatePct(covered: number, total: number) {
    if (total === 0) {
        return 100;
    }

    return Number(((covered / total) * 100).toFixed(2));
}

export function aggregateCoverageArea(
    snapshot: ICoverageSnapshot,
    area: ICoverageAreaDefinition,
): ICoverageAreaSnapshot {
    const metrics = {} as Record<TCoverageMetric, ICoverageMetricSummary>;
    const matchingFiles = snapshot.files.filter(file => (
        area.include.some(prefix => file.filePath.startsWith(prefix))
    ));

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = createEmptyMetricSummary();
    }

    for (const file of matchingFiles) {
        for (const metric of COVERAGE_METRICS) {
            metrics[metric].covered += file.metrics[metric].covered;
            metrics[metric].skipped += file.metrics[metric].skipped;
            metrics[metric].total += file.metrics[metric].total;
        }
    }

    for (const metric of COVERAGE_METRICS) {
        metrics[metric].pct = calculatePct(metrics[metric].covered, metrics[metric].total);
    }

    return {
        fileCount: matchingFiles.length,
        metrics,
    };
}

function compareMetricRecordToBaseline(
    currentMetrics: Record<TCoverageMetric, ICoverageMetricSummary>,
    baselineMetrics: Record<TCoverageMetric, number>,
    tolerancePercentagePoints: number,
    scope: 'area' | 'total',
    area?: string,
) {
    return COVERAGE_METRICS.map((metric): ICoverageComparison => {
        const baselinePct = baselineMetrics[metric];
        const currentPct = currentMetrics[metric].pct;
        const deltaPercentagePoints = Number((currentPct - baselinePct).toFixed(2));
        const status: ICoverageComparison['status'] = deltaPercentagePoints === 0
            ? 'unchanged'
            : deltaPercentagePoints > 0
                ? 'improved'
                : deltaPercentagePoints < -tolerancePercentagePoints
                    ? 'regressed'
                    : 'within-tolerance';

        return {
            ...(area ? {area} : {}),
            baselinePct,
            currentPct,
            deltaPercentagePoints,
            metric,
            scope,
            status,
        };
    });
}

export function compareCoverageToBaseline(
    snapshot: ICoverageSnapshot,
    baseline: ICoverageBaseline,
    tolerancePercentagePoints = baseline.tolerancePercentagePoints,
): ICoverageRatchetResult {
    const comparisons = compareMetricRecordToBaseline(
        snapshot.metrics,
        baseline.metrics,
        tolerancePercentagePoints,
        'total',
    );

    for (const [
        areaName,
        areaBaseline,
    ] of Object.entries(baseline.areas ?? {})
            .sort(([left], [right]) => left.localeCompare(right))) {
        const areaSnapshot = aggregateCoverageArea(snapshot, areaBaseline);
        if (areaSnapshot.fileCount === 0) {
            comparisons.push(...COVERAGE_METRICS.map((metric): ICoverageComparison => ({
                area: areaName,
                baselinePct: areaBaseline.metrics[metric],
                currentPct: 0,
                deltaPercentagePoints: Number((-areaBaseline.metrics[metric]).toFixed(2)),
                metric,
                scope: 'area',
                status: 'missing',
            })));
            continue;
        }

        comparisons.push(...compareMetricRecordToBaseline(
            areaSnapshot.metrics,
            areaBaseline.metrics,
            tolerancePercentagePoints,
            'area',
            areaName,
        ));
    }

    return {
        comparisons,
        passed: comparisons.every(comparison => comparison.status !== 'regressed' && comparison.status !== 'missing'),
        tolerancePercentagePoints,
    };
}

export function formatCoverageRatchetResult(result: ICoverageRatchetResult) {
    const header = result.passed
        ? 'Coverage ratchet passed.'
        : 'Coverage ratchet failed.';
    const details = result.comparisons.map((comparison) => {
        const deltaPrefix = comparison.deltaPercentagePoints > 0 ? '+' : '';
        const label = comparison.scope === 'area'
            ? `${comparison.area} ${comparison.metric}`
            : `total ${comparison.metric}`;
        return `  ${label}: ${comparison.currentPct.toFixed(2)}% (${deltaPrefix}${comparison.deltaPercentagePoints.toFixed(2)} pp, baseline ${comparison.baselinePct.toFixed(2)}%, ${comparison.status})`;
    });

    return [
        `${header} Regression tolerance: ${result.tolerancePercentagePoints.toFixed(2)} percentage points.`,
        ...details,
    ].join('\n');
}

function parseArgs(args: string[]): IParsedArgs {
    const parsed: IParsedArgs = {
        baselinePath: DEFAULT_BASELINE_PATH,
        summaryPath: DEFAULT_SUMMARY_PATH,
        updateBaseline: false,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];

        if (arg === '--update-baseline') {
            parsed.updateBaseline = true;
            continue;
        }

        if (arg === '--baseline') {
            const value = args[index + 1];
            if (value === undefined) {
                throw new Error('--baseline requires a path.');
            }
            parsed.baselinePath = value;
            index += 1;
            continue;
        }

        if (arg === '--summary') {
            const value = args[index + 1];
            if (value === undefined) {
                throw new Error('--summary requires a path.');
            }
            parsed.summaryPath = value;
            index += 1;
            continue;
        }

        if (arg === '--tolerance') {
            const value = args[index + 1];
            if (value === undefined) {
                throw new Error('--tolerance requires a percentage-point value.');
            }
            parsed.tolerancePercentagePoints = assertNumber(
                Number(value),
                '--tolerance',
            );
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg ?? '<empty>'}`);
    }

    return parsed;
}

export async function runCoverageRatchet(args: string[], cwd = process.cwd()) {
    const parsedArgs = parseArgs(args);
    const summaryPath = path.resolve(cwd, parsedArgs.summaryPath);
    const baselinePath = path.resolve(cwd, parsedArgs.baselinePath);
    const snapshot = parseCoverageSummary(await readFile(summaryPath, 'utf8'), cwd);
    const tolerancePercentagePoints = parsedArgs.tolerancePercentagePoints ?? DEFAULT_TOLERANCE_PERCENTAGE_POINTS;

    if (parsedArgs.updateBaseline) {
        const baseline = createCoverageBaseline(snapshot, tolerancePercentagePoints);
        await writeFile(baselinePath, stringifyCoverageBaseline(baseline), 'utf8');
        return {
            message: `Coverage baseline updated at ${path.relative(cwd, baselinePath).split(path.sep).join('/')}.`,
            passed: true,
        };
    }

    const baseline = parseCoverageBaseline(await readFile(baselinePath, 'utf8'));
    const result = compareCoverageToBaseline(
        snapshot,
        baseline,
        parsedArgs.tolerancePercentagePoints,
    );

    return {
        message: formatCoverageRatchetResult(result),
        passed: result.passed,
    };
}

async function main() {
    try {
        const result = await runCoverageRatchet(process.argv.slice(2));
        const write = result.passed ? console.log : console.error;
        write(result.message);
        process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
