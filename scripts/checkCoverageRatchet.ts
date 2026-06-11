import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export type TCoverageMetric = typeof COVERAGE_METRICS[number];

export interface ICoverageMetricSummary {
    covered: number;
    pct: number;
    skipped: number;
    total: number;
}

export interface ICoverageSnapshot { metrics: Record<TCoverageMetric, ICoverageMetricSummary> }

export interface ICoverageBaseline {
    metrics: Record<TCoverageMetric, number>;
    tolerancePercentagePoints: number;
    version: typeof BASELINE_VERSION;
}

export interface ICoverageComparison {
    baselinePct: number;
    currentPct: number;
    deltaPercentagePoints: number;
    metric: TCoverageMetric;
    status: 'improved' | 'regressed' | 'unchanged' | 'within-tolerance';
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be a finite number.`);
    }

    return value;
}

function parseJsonObject(source: string, label: string) {
    const parsed = JSON.parse(source) as unknown;

    if (!isRecord(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    return parsed;
}

export function parseCoverageSummary(source: string): ICoverageSnapshot {
    const parsed = parseJsonObject(source, 'Coverage summary');
    const total = parsed.total;

    if (!isRecord(total)) {
        throw new Error('Coverage summary must contain a total object.');
    }

    const metrics = {} as Record<TCoverageMetric, ICoverageMetricSummary>;

    for (const metric of COVERAGE_METRICS) {
        const rawMetric = total[metric];

        if (!isRecord(rawMetric)) {
            throw new Error(`Coverage summary total.${metric} must be an object.`);
        }

        metrics[metric] = {
            covered: assertNumber(rawMetric.covered, `Coverage summary total.${metric}.covered`),
            pct: assertNumber(rawMetric.pct, `Coverage summary total.${metric}.pct`),
            skipped: assertNumber(rawMetric.skipped, `Coverage summary total.${metric}.skipped`),
            total: assertNumber(rawMetric.total, `Coverage summary total.${metric}.total`),
        };
    }

    return { metrics };
}

export function parseCoverageBaseline(source: string): ICoverageBaseline {
    const parsed = parseJsonObject(source, 'Coverage baseline');

    if (parsed.version !== BASELINE_VERSION) {
        throw new Error(`Coverage baseline version must be ${BASELINE_VERSION}.`);
    }

    const metricsObject = parsed.metrics;
    if (!isRecord(metricsObject)) {
        throw new Error('Coverage baseline must contain a metrics object.');
    }

    const metrics = {} as Record<TCoverageMetric, number>;

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = assertNumber(metricsObject[metric], `Coverage baseline metrics.${metric}`);
    }

    return {
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
): ICoverageBaseline {
    const metrics = {} as Record<TCoverageMetric, number>;

    for (const metric of COVERAGE_METRICS) {
        metrics[metric] = snapshot.metrics[metric].pct;
    }

    return {
        metrics,
        tolerancePercentagePoints,
        version: BASELINE_VERSION,
    };
}

export function stringifyCoverageBaseline(baseline: ICoverageBaseline) {
    return `${JSON.stringify({
        version: baseline.version,
        tolerancePercentagePoints: baseline.tolerancePercentagePoints,
        metrics: {
            statements: baseline.metrics.statements,
            branches: baseline.metrics.branches,
            functions: baseline.metrics.functions,
            lines: baseline.metrics.lines,
        },
    }, null, 2)}\n`;
}

export function compareCoverageToBaseline(
    snapshot: ICoverageSnapshot,
    baseline: ICoverageBaseline,
    tolerancePercentagePoints = baseline.tolerancePercentagePoints,
): ICoverageRatchetResult {
    const comparisons = COVERAGE_METRICS.map((metric): ICoverageComparison => {
        const baselinePct = baseline.metrics[metric];
        const currentPct = snapshot.metrics[metric].pct;
        const deltaPercentagePoints = Number((currentPct - baselinePct).toFixed(2));
        const status: ICoverageComparison['status'] = deltaPercentagePoints === 0
            ? 'unchanged'
            : deltaPercentagePoints > 0
                ? 'improved'
                : deltaPercentagePoints < -tolerancePercentagePoints
                    ? 'regressed'
                    : 'within-tolerance';

        return {
            baselinePct,
            currentPct,
            deltaPercentagePoints,
            metric,
            status,
        };
    });

    return {
        comparisons,
        passed: comparisons.every(comparison => comparison.status !== 'regressed'),
        tolerancePercentagePoints,
    };
}

export function formatCoverageRatchetResult(result: ICoverageRatchetResult) {
    const header = result.passed
        ? 'Coverage ratchet passed.'
        : 'Coverage ratchet failed.';
    const details = result.comparisons.map((comparison) => {
        const deltaPrefix = comparison.deltaPercentagePoints > 0 ? '+' : '';
        return `  ${comparison.metric}: ${comparison.currentPct.toFixed(2)}% (${deltaPrefix}${comparison.deltaPercentagePoints.toFixed(2)} pp, baseline ${comparison.baselinePct.toFixed(2)}%, ${comparison.status})`;
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
    const snapshot = parseCoverageSummary(await readFile(summaryPath, 'utf8'));
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
