import {
    mkdir,
    readFile,
    rename,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
} from 'node:path';
import { percentile } from '@scripts/stress/percentile';
import type {
    IStressBaseline,
    IStressBaselineScenario,
    IStressFinding,
    IStressRun,
    IStressScenarioResult,
    TStressHostProfileId,
} from '@scripts/stress/stressTypes';

export const DEFAULT_STRESS_BASELINE_DIR = join(process.cwd(), 'docs', 'benchmarks', 'stress');
export const DEFAULT_STRESS_RUNS_DIR = join(process.cwd(), '.devkit', 'stress', 'runs');
/** Enough history for p95 to mean something without the baseline file growing forever. */
export const BASELINE_SAMPLE_WINDOW = 20;

function pad2(value: number) {
    return String(value).padStart(2, '0');
}

export function buildStressRunId(now: Date, gitSha: string, profile: TStressHostProfileId) {
    const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
    return `${stamp}-${gitSha.slice(0, 8)}-${profile}`;
}

export function computeStressRunTotals(scenarios: readonly IStressScenarioResult[]) {
    return {
        passed: scenarios.filter(scenario => scenario.status === 'passed').length,
        failed: scenarios.filter(scenario => scenario.status === 'failed').length,
        infraFailed: scenarios.filter(scenario => scenario.status === 'infra-failed').length,
        skipped: scenarios.filter(scenario => scenario.status === 'skipped').length,
        costUsd: scenarios.reduce((sum, scenario) => sum + (scenario.operator?.costUsd ?? 0), 0),
    };
}

export function resolveStressRunVerdict(run: Pick<IStressRun, 'scenarios' | 'finishedAt'>) {
    if (run.finishedAt === null) {
        return 'incomplete';
    }
    return run.scenarios.some(scenario => scenario.status === 'failed' || scenario.status === 'infra-failed')
        ? 'failed'
        : 'passed';
}

export async function writeStressRunJson(runDir: string, run: IStressRun) {
    await mkdir(runDir, {recursive: true});
    const path = join(runDir, 'run.json');
    const tmpPath = `${path}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    await rename(tmpPath, path);
    return path;
}

function formatBytes(bytes: number | null) {
    if (bytes === null) {
        return '-';
    }
    return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}

function formatFinding(finding: IStressFinding) {
    return `- **${finding.severity}** \`${finding.oracle}\`: ${finding.message}`;
}

export function renderStressSummaryMarkdown(run: IStressRun) {
    const lines: string[] = [];
    lines.push(`# Stress run ${run.runId}`);
    lines.push('');
    lines.push(`Verdict: **${run.verdict}**. Profile \`${run.hostProfile}\` on ${run.platform}, commit \`${run.gitSha.slice(0, 8)}\`.`);
    lines.push('');
    lines.push('| Scenarios | Passed | Failed | Infra failed | Skipped | Operator cost |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    lines.push(`| ${run.scenarios.length} | ${run.totals.passed} | ${run.totals.failed} | ${run.totals.infraFailed} | ${run.totals.skipped} | $${run.totals.costUsd.toFixed(2)} |`);
    lines.push('');

    if (run.calibration) {
        lines.push('## Calibration');
        lines.push('');
        for (const check of run.calibration.checks) {
            lines.push(`- ${check.verdict === 'met' ? 'ok' : check.verdict}: ${check.check}. ${check.detail}`);
        }
        if (run.calibration.checks.length === 0) {
            lines.push('- no constraints to verify for this profile');
        }
        lines.push('');
    }

    const ordered = [...run.scenarios].sort((left, right) => severityScore(right) - severityScore(left));
    lines.push('## Scenarios');
    lines.push('');
    lines.push('| Scenario | Status | Duration | Peak RSS | Heartbeat gap | Long task p95 | Findings |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const scenario of ordered) {
        const metrics = scenario.metrics;
        lines.push(`| ${scenario.id} | ${scenario.status} | ${(scenario.durationMs / 1000).toFixed(1)}s | ${formatBytes(metrics?.peakRssBytes ?? null)} | ${metrics ? `${metrics.heartbeatMaxGapMs.toFixed(0)}ms` : '-'} | ${metrics ? `${metrics.longTaskP95Ms.toFixed(0)}ms` : '-'} | ${scenario.findings.length} |`);
    }
    lines.push('');

    for (const scenario of ordered) {
        if (scenario.findings.length === 0 && !scenario.infraError && !scenario.operator) {
            continue;
        }
        lines.push(`### ${scenario.id}`);
        lines.push('');
        if (scenario.infraError) {
            lines.push(`Infrastructure error: ${scenario.infraError}`);
            lines.push('');
        }
        if (scenario.operator) {
            const report = scenario.operator.report;
            if (scenario.operator.operatorProfile === 'external') {
                lines.push(`External operator: ${scenario.operator.stopReason}. Agent turns, actions and subscription usage are not measured by this runner. No model API calls were made by the runner. See the task card and operator report for evidence.`);
            } else {
                lines.push(`Operator ${scenario.operator.model} (${scenario.operator.operatorProfile}): ${scenario.operator.turns} turns, ${scenario.operator.actions} actions, cost $${(scenario.operator.costUsd ?? 0).toFixed(3)}, stop reason ${scenario.operator.stopReason}.`);
            }
            if (report) {
                lines.push(`Reported outcome: ${report.outcome}${report.problem ? `. Problem: ${report.problem}` : ''}${report.slowestAction ? `. Slowest: ${report.slowestAction}` : ''}`);
            }
            lines.push('');
        }
        for (const finding of scenario.findings) {
            lines.push(formatFinding(finding));
        }
        if (scenario.findings.length > 0) {
            lines.push('');
        }
    }

    return `${lines.join('\n').trimEnd()}\n`;
}

function severityScore(scenario: IStressScenarioResult) {
    const weights = {
        critical: 1000,
        major: 100,
        minor: 10,
        info: 1,
    };
    const statusWeight = scenario.status === 'infra-failed' ? 5000 : scenario.status === 'failed' ? 2000 : 0;
    return statusWeight + scenario.findings.reduce((sum, finding) => sum + weights[finding.severity], 0);
}

export function stressBaselinePath(profile: TStressHostProfileId, baselineDir = DEFAULT_STRESS_BASELINE_DIR) {
    return join(baselineDir, `${profile}.json`);
}

function isBaseline(value: unknown): value is IStressBaseline {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.schemaVersion === 1
        && typeof candidate.hostProfile === 'string'
        && typeof candidate.scenarios === 'object'
        && candidate.scenarios !== null;
}

export async function readStressBaseline(path: string) {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        return isBaseline(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function createEmptyStressBaseline(profile: TStressHostProfileId): IStressBaseline {
    return {
        schemaVersion: 1,
        hostProfile: profile,
        tier: null,
        calibration: {
            cpuLoopMs: null,
            diskRead64MiBMs: null,
            maxCalibrationDriftPercent: 30,
        },
        defaults: {
            maxRegressionPercent: 25,
            minRegressionMs: 150,
            improvementRecordPercent: 20,
            minIterations: 1,
        },
        scenarios: {},
    };
}

function scenarioDurations(result: IStressScenarioResult) {
    const durations: Record<string, number> = {total: result.durationMs};
    for (const step of result.steps) {
        if (step.status !== 'succeeded') {
            continue;
        }
        const key = step.step.kind === 'open' ? `open:${step.step.fixture}` : step.step.kind;
        durations[key] = (durations[key] ?? 0) + step.durationMs;
    }
    return durations;
}

/**
 * Regression rules from the baseline's `defaults`: a duration regresses only
 * when it is both `maxRegressionPercent` slower and at least
 * `minRegressionMs` slower, so 10 ms jitter on a 20 ms step never fails.
 */
export function compareStressResultWithBaseline(baseline: IStressBaseline, result: IStressScenarioResult): IStressFinding[] {
    const reference = baseline.scenarios[result.id];
    if (!reference) {
        return [{
            severity: 'info',
            oracle: 'baseline-missing',
            message: `no baseline entry for ${result.id} in profile ${baseline.hostProfile}; run with --update-baseline to record one`,
        }];
    }
    const findings: IStressFinding[] = [];
    const durations = scenarioDurations(result);
    for (const [
        metric,
        current,
    ] of Object.entries(durations)) {
        const previous = reference.durations[metric];
        if (!previous) {
            continue;
        }
        const delta = current - previous.p95;
        const percent = previous.p95 > 0 ? (delta / previous.p95) * 100 : 0;
        const overPercentRule = previous.p95 === 0 || percent >= baseline.defaults.maxRegressionPercent;
        if (delta >= baseline.defaults.minRegressionMs && overPercentRule) {
            findings.push({
                severity: 'major',
                oracle: 'baseline-regression',
                message: previous.p95 === 0
                    ? `${metric}: ${current}ms vs baseline p95 0ms (+${delta}ms)`
                    : `${metric}: ${current}ms vs baseline p95 ${previous.p95}ms (+${percent.toFixed(0)}%)`,
            });
        } else if (delta < 0 && -percent >= baseline.defaults.improvementRecordPercent) {
            findings.push({
                severity: 'info',
                oracle: 'baseline-improvement',
                message: `${metric}: ${current}ms vs baseline p95 ${previous.p95}ms (${percent.toFixed(0)}%)`,
            });
        }
    }
    const metrics = result.metrics;
    if (metrics && metrics.peakRssBytes > reference.hardCeilings.peakElectronRssBytes) {
        findings.push({
            severity: 'major',
            oracle: 'baseline-rss-ceiling',
            message: `peak RSS ${formatBytes(metrics.peakRssBytes)} exceeds baseline ceiling ${formatBytes(reference.hardCeilings.peakElectronRssBytes)}`,
        });
    }
    if (metrics && metrics.heartbeatMaxGapMs > reference.responsiveness.heartbeatMaxGapMs) {
        findings.push({
            severity: 'major',
            oracle: 'baseline-heartbeat',
            message: `heartbeat gap ${metrics.heartbeatMaxGapMs.toFixed(0)}ms exceeds baseline limit ${reference.responsiveness.heartbeatMaxGapMs}ms`,
        });
    }
    return findings;
}

export function buildStressBaselineScenario(result: IStressScenarioResult, previous: IStressBaselineScenario | undefined, now: Date): IStressBaselineScenario {
    const durations: IStressBaselineScenario['durations'] = {};
    for (const [
        metric,
        value,
    ] of Object.entries(scenarioDurations(result))) {
        const samples = [
            ...(previous?.durations[metric]?.samples ?? []),
            value,
        ].slice(-BASELINE_SAMPLE_WINDOW);
        durations[metric] = {
            p50: percentile(samples, 50) ?? value,
            p95: percentile(samples, 95) ?? value,
            samples,
        };
    }
    const metrics = result.metrics;
    const peakRss = metrics?.peakRssBytes ?? 0;
    return {
        updatedAt: now.toISOString(),
        iterations: (previous?.iterations ?? 0) + 1,
        durations,
        memory: {
            peakRssBytes: peakRss,
            peakJsHeapUsedBytes: metrics?.peakJsHeapUsedBytes ?? null,
        },
        responsiveness: {
            heartbeatMaxGapMs: Math.max(2_000, Math.ceil((metrics?.heartbeatMaxGapMs ?? 0) * 1.5)),
            heartbeatObservedMaxGapMs: metrics?.heartbeatMaxGapMs ?? 0,
            longTaskP95Ms: metrics?.longTaskP95Ms ?? 0,
            frameTimeP95Ms: metrics?.frameGapP95Ms ?? 0,
            droppedFrameRatioMax: metrics?.droppedFrameRatio ?? 0,
        },
        hardCeilings: {
            crashCount: 0,
            unresponsiveCount: 0,
            pageErrorCount: 0,
            leakedProcessCount: 0,
            leakedWorkingCopyCount: 0,
            peakElectronRssBytes: Math.ceil(peakRss * 1.5),
        },
        notes: previous?.notes ?? '',
    };
}

/**
 * Refuses after a failed run: a baseline recorded from a run with critical
 * or major findings would bless the regression it should catch.
 */
export function updateStressBaseline(baseline: IStressBaseline, run: IStressRun, now = new Date()) {
    const failed = run.scenarios.filter(scenario => scenario.status === 'failed' || scenario.status === 'infra-failed');
    if (failed.length > 0) {
        throw new Error(`refusing to update baseline: ${failed.map(scenario => scenario.id).join(', ')} did not pass`);
    }
    const next: IStressBaseline = {
        ...baseline,
        tier: run.calibration?.throttled.detectedTier ?? baseline.tier,
        calibration: {
            ...baseline.calibration,
            cpuLoopMs: run.calibration?.throttled.mainThreadLoopMs ?? baseline.calibration.cpuLoopMs,
            diskRead64MiBMs: run.calibration?.throttled.diskRead64MiBMs ?? baseline.calibration.diskRead64MiBMs,
        },
        scenarios: { ...baseline.scenarios },
    };
    for (const scenario of run.scenarios) {
        if (scenario.status !== 'passed') {
            continue;
        }
        next.scenarios[scenario.id] = buildStressBaselineScenario(scenario, baseline.scenarios[scenario.id], now);
    }
    return next;
}

export async function writeStressBaseline(path: string, baseline: IStressBaseline) {
    await mkdir(dirname(path), {recursive: true});
    const tmpPath = `${path}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(baseline, null, 4)}\n`, 'utf8');
    await rename(tmpPath, path);
}
