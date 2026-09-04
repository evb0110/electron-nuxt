import { execFileSync } from 'node:child_process';
import {
    appendFile,
    copyFile,
    mkdir,
    realpath,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import { runWithElectronE2EDeadline } from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import { collectStressAppState } from '@scripts/stress/stressAppState';
import {
    buildStressCalibrationRecord,
    calibrationBlocksStressRun,
    probeStressCalibration,
} from '@scripts/stress/stressCalibration';
import {
    STRESS_CLI_USAGE,
    isStressCliEntrypoint,
    parseStressCliOptions,
    runStressCliMain,
} from '@scripts/stress/stressCliOptions';
import type { IStressCliOptions } from '@scripts/stress/stressCliOptions';
import { runStressDeterministicSteps } from '@scripts/stress/stressDeterministicDriver';
import {
    STRESS_FIXTURE_IDS,
    STRESS_FIXTURE_SPECS,
    describeStressFixtures,
    ensureStressFixtures,
} from '@scripts/stress/stressFixtures';
import type { IStressFixtureRecord } from '@scripts/stress/stressFixtures';
import {
    STRESS_HOST_PROFILES,
    describeStressHostProfile,
    resolveStressHostProfile,
} from '@scripts/stress/stressHostProfiles';
import { startStressMetricsSampler } from '@scripts/stress/stressMetricsSampler';
import { MODELS_WITHOUT_COMPUTER_USE } from '@scripts/stress/stressOperatorCost';
import { runExternalStressOperator } from '@scripts/stress/runExternalStressOperator';
import { runStressOperatorScenario } from '@scripts/stress/runStressOperatorScenario';
import type { IStressOperatorToolContext } from '@scripts/stress/stressOperatorToolExecutor';
import {
    collectMacOSCrashReports,
    evaluateStressOracles,
    isStressFailure,
    listLeakedPdfWorkDirs,
    runQpdfIntegrityCheck,
    sortStressFindings,
} from '@scripts/stress/stressOracles';
import {
    DEFAULT_STRESS_RUNS_DIR,
    buildStressRunId,
    compareStressResultWithBaseline,
    computeStressRunTotals,
    createEmptyStressBaseline,
    readStressBaseline,
    renderStressSummaryMarkdown,
    resolveStressRunVerdict,
    stressBaselinePath,
    updateStressBaseline,
    writeStressBaseline,
    writeStressRunJson,
} from '@scripts/stress/stressReport';
import {
    DEFAULT_STRESS_RUN_BUDGET,
    STRESS_SCENARIOS,
    resolveStressThresholds,
    selectStressScenarios,
} from '@scripts/stress/stressScenarioRegistry';
import { startStressSession } from '@scripts/stress/stressSessionLifecycle';
import type { IStressSessionHandle } from '@scripts/stress/stressSessionLifecycle';
import type {
    IStressCalibrationRecord,
    IStressFinding,
    IStressHostProfile,
    IStressIntegrityCheck,
    IStressRun,
    IStressScenarioResult,
    TStressFixtureId,
    TStressScenario,
} from '@scripts/stress/stressTypes';

const DETERMINISTIC_STEP_TIMEOUT_MS = 120_000;
const CONSOLE_ERROR_ALLOWLIST = [
    /ResizeObserver loop/u,
    /favicon\.ico/u,
];

interface IRunContext {
    options: IStressCliOptions;
    profile: IStressHostProfile;
    runId: string;
    runDir: string;
    fixtures: Map<TStressFixtureId, IStressFixtureRecord>;
    runStartedAt: number;
    runCostUsd: number;
    maxRunCostUsd: number;
    /** Whichever Electron session is live right now, so an interrupt can stop it. */
    activeSession: IStressSessionHandle | null;
    log: (line: string) => void;
}

function readGitSha() {
    try {
        return execFileSync('git', [
            'rev-parse',
            'HEAD',
        ], {encoding: 'utf8'}).trim();
    } catch {
        return 'unknown';
    }
}

function createLogger(runDir: string | null) {
    const startedAt = Date.now();
    return (line: string) => {
        const stamped = `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${line}`;
        console.log(stamped);
        if (runDir) {
            void appendFile(join(runDir, 'run.log'), `${stamped}\n`).catch(() => {});
        }
    };
}

function printList() {
    console.log('Scenarios');
    for (const scenario of STRESS_SCENARIOS) {
        console.log(`  ${scenario.id} [${scenario.kind}] tags=${scenario.tags.join(',')} fixtures=${scenario.fixtures.join(',')} profile=${scenario.defaultProfile}`);
        console.log(`      ${scenario.description}`);
    }
    console.log('\nHost profiles');
    for (const profile of Object.values(STRESS_HOST_PROFILES)) {
        console.log(describeStressHostProfile(profile).split('\n').map(line => `  ${line}`).join('\n'));
    }
    console.log('\nFixtures');
    console.log(describeStressFixtures().split('\n').map(line => `  ${line}`).join('\n'));
}

function collectFixtureIds(scenarios: readonly TStressScenario[]) {
    const ids = new Set<TStressFixtureId>();
    for (const scenario of scenarios) {
        for (const id of scenario.fixtures) {
            ids.add(id);
        }
    }
    return [...ids];
}

async function calibrate(handle: IStressSessionHandle, fixtures: Map<TStressFixtureId, IStressFixtureRecord>, log: (line: string) => void): Promise<IStressCalibrationRecord> {
    const diskReadPath = fixtures.get('scanned-large-431')?.path ?? fixtures.get('many-pages-text-4000')?.path ?? null;
    const {cdpSession} = handle.applied;
    log('calibration: probing unthrottled renderer');
    await cdpSession.send('Emulation.setCPUThrottlingRate', {rate: 1});
    const unthrottled = await probeStressCalibration(handle.session.page, {diskReadPath});
    await cdpSession.send('Emulation.setCPUThrottlingRate', {rate: handle.profile.cpuThrottlingRate});
    log(`calibration: probing at throttling rate ${handle.profile.cpuThrottlingRate}`);
    const throttled = await probeStressCalibration(handle.session.page, {diskReadPath});
    const record = buildStressCalibrationRecord(handle.profile, unthrottled, throttled);
    for (const check of record.checks) {
        log(`calibration ${check.check}: ${check.verdict} (${check.detail})`);
    }
    return record;
}

async function prepareWorkingCopies(scenario: TStressScenario, fixtures: Map<TStressFixtureId, IStressFixtureRecord>, scenarioDir: string) {
    const scenarioFixtures = new Map(fixtures);
    const workingDir = join(scenarioDir, 'working');
    const copies: string[] = [];
    for (const id of scenario.workingCopies) {
        const record = fixtures.get(id);
        if (!record?.available) {
            continue;
        }
        await mkdir(workingDir, {recursive: true});
        const target = join(workingDir, basename(record.path));
        await copyFile(record.path, target);
        scenarioFixtures.set(id, {
            ...record,
            path: target,
        });
        copies.push(target);
    }
    return {
        scenarioFixtures,
        copies,
    };
}

async function buildAllowedPaths(scenario: TStressScenario, fixtures: Map<TStressFixtureId, IStressFixtureRecord>) {
    const allowed = new Map<string, {kind: 'pdf' | 'djvu'}>();
    const filePaths: string[] = [];
    for (const id of scenario.fixtures) {
        const record = fixtures.get(id);
        if (!record?.available) {
            continue;
        }
        const real = await realpath(record.path);
        allowed.set(real, {kind: STRESS_FIXTURE_SPECS[id].kind});
        filePaths.push(real);
    }
    return {
        allowed,
        filePaths,
    };
}

async function runScenario(context: IRunContext, scenario: TStressScenario): Promise<IStressScenarioResult> {
    const {log} = context;
    const startedAt = new Date();
    const scenarioDir = join(context.runDir, scenario.id);
    await mkdir(scenarioDir, {recursive: true});
    const thresholds = resolveStressThresholds(scenario);
    const deadlineAt = Math.min(startedAt.getTime() + scenario.budgets.deadlineMs, context.runStartedAt + DEFAULT_STRESS_RUN_BUDGET.deadlineMs);
    const result: IStressScenarioResult = {
        id: scenario.id,
        kind: scenario.kind,
        status: 'passed',
        startedAt: startedAt.toISOString(),
        durationMs: 0,
        profileId: context.profile.id,
        findings: [],
        metrics: null,
        steps: [],
        operator: null,
        artifacts: {},
        infraError: null,
    };
    await writeFile(join(scenarioDir, 'manifest.json'), `${JSON.stringify({
        runId: context.runId,
        scenarioId: scenario.id,
        kind: scenario.kind,
        profile: context.profile.id,
        model: scenario.kind === 'operator' ? (context.options.operatorProfile === 'external' ? 'external-agent' : context.options.model) : null,
        operatorProfile: scenario.kind === 'operator' ? context.options.operatorProfile : null,
        startedAt: result.startedAt,
        thresholds,
        budgets: scenario.budgets,
    }, null, 2)}\n`, 'utf8');

    const missing = scenario.fixtures.filter(id => !context.fixtures.get(id)?.available);
    if (missing.length > 0) {
        result.status = 'skipped';
        result.infraError = `fixtures unavailable: ${missing.map(id => `${id} (${context.fixtures.get(id)?.reason ?? 'not generated'})`).join('; ')}`;
        log(`${scenario.id}: skipped, ${result.infraError}`);
        return result;
    }

    let handle: IStressSessionHandle | null = null;
    let leakedPids: number[] = [];
    let frozenScreenshotStreak = 0;
    const integrity: IStressIntegrityCheck[] = [];
    try {
        handle = await startStressSession(scenario.id, context.profile, log, scenario.kind === 'operator' && context.options.operatorProfile === 'external');
        context.activeSession = handle;
        const {
            scenarioFixtures,
            copies,
        } = await prepareWorkingCopies(scenario, context.fixtures, scenarioDir);
        const metricsPath = join(scenarioDir, 'metrics.jsonl');
        result.artifacts.metrics = metricsPath;
        const sampler = await startStressMetricsSampler({
            page: handle.session.page,
            electronPid: handle.electronPid,
            outputPath: metricsPath,
            consoleErrorAllowlist: CONSOLE_ERROR_ALLOWLIST,
            log,
        });
        const scenarioStartedEpoch = Date.now();
        try {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
                throw new Error('Stress scenario deadline expired during session setup');
            }
            const budgets = {
                ...scenario.budgets,
                deadlineMs: remainingMs,
            };
            if (scenario.kind === 'deterministic') {
                const session = handle.session;
                result.steps = await runWithElectronE2EDeadline(`stress scenario ${scenario.id}`, budgets.deadlineMs, signal => runStressDeterministicSteps(scenario.steps, {
                    signal,
                    session,
                    fixtures: scenarioFixtures,
                    stepTimeoutMs: Math.min(DETERMINISTIC_STEP_TIMEOUT_MS, remainingMs),
                    log,
                }));
            } else {
                const {
                    allowed,
                    filePaths,
                } = await buildAllowedPaths(scenario, scenarioFixtures);
                const toolContext: IStressOperatorToolContext = {
                    session: handle.session,
                    allowedPaths: allowed,
                    viewport: {
                        width: context.profile.deviceMetrics.width,
                        height: context.profile.deviceMetrics.height,
                    },
                    stepTimeoutMs: Math.min(DETERMINISTIC_STEP_TIMEOUT_MS, remainingMs),
                    log,
                };
                const external = context.options.operatorProfile === 'external';
                const driveOperator = external ? runExternalStressOperator : runStressOperatorScenario;
                const operator = await runWithElectronE2EDeadline(`stress operator ${scenario.id}`, Math.max(1, deadlineAt - Date.now()), signal => driveOperator({
                    signal,
                    deadlineAt,
                    scenario,
                    runId: context.runId,
                    model: external ? 'external-agent' : context.options.model,
                    operatorProfile: context.options.operatorProfile,
                    budgets,
                    runCost: {
                        totalUsd: () => context.runCostUsd,
                        maxUsd: context.maxRunCostUsd,
                    },
                    filePaths,
                    toolContext,
                    sampler,
                    scenarioDir,
                    enableThinking: context.options.thinking,
                    log,
                }));
                context.runCostUsd += operator.costUsd ?? 0;
                frozenScreenshotStreak = operator.frozenScreenshotStreak;
                Object.assign(result.artifacts, operator.artifacts);
                result.operator = {
                    model: external ? 'external-agent' : context.options.model,
                    operatorProfile: context.options.operatorProfile,
                    turns: operator.turns,
                    actions: operator.actions,
                    costUsd: operator.costUsd,
                    report: operator.report,
                    stopReason: operator.stopReason,
                };
                if (operator.stopReason.startsWith('api error')) {
                    result.infraError = operator.stopReason;
                }
            }
        } finally {
            result.metrics = await sampler.stop();
        }
        const finalStatePage = handle.session.page;
        const finalAppState = await runWithElectronE2EDeadline(
            `stress final state ${scenario.id}`,
            Math.min(5_000, Math.max(1, deadlineAt - Date.now())),
            () => collectStressAppState(finalStatePage),
        ).catch(() => null);
        for (const copy of copies) {
            if (copy.toLowerCase().endsWith('.pdf')) {
                integrity.push(await runQpdfIntegrityCheck(copy));
            }
        }
        const stopped = await handle.stop();
        handle = null;
        context.activeSession = null;
        leakedPids = stopped.leakedPids;
        const [
            crashReports,
            leakedWorkDirs,
        ] = await Promise.all([
            collectMacOSCrashReports(scenarioStartedEpoch),
            listLeakedPdfWorkDirs(scenarioStartedEpoch),
        ]);
        result.findings = evaluateStressOracles({
            thresholds,
            metrics: result.metrics,
            steps: result.steps,
            finalAppState,
            integrity,
            leakedPids,
            leakedWorkDirs,
            crashReports,
            frozenScreenshotStreak,
        });
        if (result.operator?.report?.outcome === 'app_broken') {
            result.findings.push({
                severity: 'major',
                oracle: 'operator-report',
                message: `operator reported app_broken: ${result.operator.report.problem ?? 'no detail'}`,
            });
        } else if (result.operator && !result.metrics?.rendererCrashed && result.operator.report?.outcome !== 'completed') {
            result.infraError = `operator did not complete: ${result.operator.report?.problem ?? result.operator.stopReason}`;
            result.findings.push({
                severity: 'info',
                oracle: 'operator-report',
                message: result.infraError,
            });
        }
        result.findings = sortStressFindings(result.findings);
        result.status = result.infraError ? 'infra-failed' : isStressFailure(result.findings) ? 'failed' : 'passed';
    } catch (error) {
        result.status = 'infra-failed';
        result.infraError = error instanceof Error ? error.stack ?? error.message : String(error);
        log(`${scenario.id}: infrastructure failure: ${result.infraError}`);
    } finally {
        if (handle) {
            try {
                await handle.stop();
            } catch (error) {
                log(`${scenario.id}: stop after failure threw: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        context.activeSession = null;
    }
    result.durationMs = Date.now() - startedAt.getTime();
    const resultPath = join(scenarioDir, 'result.json');
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    result.artifacts.result = resultPath;
    log(`${scenario.id}: ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s, ${result.findings.length} finding(s)`);
    for (const finding of result.findings) {
        log(`  ${finding.severity} ${finding.oracle}: ${finding.message}`);
    }
    return result;
}

function applyBaselineFindings(result: IStressScenarioResult, baselineFindings: IStressFinding[]) {
    if (baselineFindings.length === 0) {
        return;
    }
    result.findings = sortStressFindings([
        ...result.findings,
        ...baselineFindings,
    ]);
    if (result.status === 'passed' && isStressFailure(result.findings)) {
        result.status = 'failed';
    }
}

/** Whole CLI as a function of argv so tests can drive it without spawning a process. */
export async function runStress(argv: readonly string[]) {
    const options = parseStressCliOptions(argv);
    if (options.help) {
        console.log(STRESS_CLI_USAGE);
        return 0;
    }
    if (options.list) {
        printList();
        return 0;
    }
    const bootstrapLog = createLogger(null);
    if (options.fixturesOnly) {
        const records = await ensureStressFixtures(STRESS_FIXTURE_IDS, {log: bootstrapLog});
        for (const record of records.values()) {
            bootstrapLog(`${record.id}: ${record.available ? `${record.path} (${(record.bytes / 1024 / 1024).toFixed(1)} MiB)` : `unavailable: ${record.reason}`}`);
        }
        return [...records.values()].every(record => record.available) ? 0 : 1;
    }

    const profile = resolveStressHostProfile(options.profile);
    const scenarios = options.calibrateOnly
        ? []
        : selectStressScenarios({
            ids: options.scenarioIds,
            tags: options.tags,
            kind: options.kind,
        });
    if (scenarios.length === 0 && !options.calibrateOnly) {
        throw new Error('no scenarios matched; use --list to see ids and tags');
    }
    const operatorScenarios = scenarios.filter(scenario => scenario.kind === 'operator');
    if (operatorScenarios.length > 0 && options.operatorProfile !== 'external') {
        if (options.operatorProfile === 'pixel' && MODELS_WITHOUT_COMPUTER_USE.has(options.model)) {
            throw new Error(`${options.model} has no computer-use support; pass --operator semantic or choose another model`);
        }
        if (!options.dryRun && !process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY is not set; operator scenarios need it (deterministic scenarios do not)');
        }
    }

    const gitSha = readGitSha();
    const now = new Date();
    const runId = buildStressRunId(now, gitSha, profile.id);
    const runDir = options.out ? resolve(options.out) : join(DEFAULT_STRESS_RUNS_DIR, runId);
    await mkdir(runDir, {recursive: true});
    const log = createLogger(runDir);
    log(`run ${runId} → ${runDir}`);
    log(describeStressHostProfile(profile));

    const fixtureIds = options.calibrateOnly
        ? (['scanned-large-431'] as TStressFixtureId[])
        : collectFixtureIds(scenarios);
    const fixtures = await ensureStressFixtures(fixtureIds, {log});

    if (options.dryRun) {
        log('dry run: plan resolved, Electron not launched');
        for (const scenario of scenarios) {
            const missing = scenario.fixtures.filter(id => !fixtures.get(id)?.available);
            log(`  ${scenario.id} [${scenario.kind}]${missing.length > 0 ? ` would be skipped (missing ${missing.join(', ')})` : ''}`);
        }
        if (operatorScenarios.length > 0) {
            if (options.operatorProfile === 'external') {
                log('  external operator: the current agent drives the visible app; no model API calls or API spend');
            } else {
                log(`  operator model ${options.model} (${options.operatorProfile}), per-scenario cap $${operatorScenarios[0]?.budgets.maxCostUsd.toFixed(2)}, run cap $${(options.maxRunCostUsd ?? DEFAULT_STRESS_RUN_BUDGET.maxCostUsd).toFixed(2)}`);
            }
        }
        return 0;
    }

    const run: IStressRun = {
        schemaVersion: 1,
        runId,
        startedAt: now.toISOString(),
        finishedAt: null,
        gitSha,
        hostProfile: profile.id,
        platform: `${process.platform}-${process.arch}`,
        calibration: null,
        scenarios: [],
        totals: computeStressRunTotals([]),
        verdict: 'incomplete',
    };
    const context: IRunContext = {
        options,
        profile,
        runId,
        runDir,
        fixtures,
        runStartedAt: Date.now(),
        runCostUsd: 0,
        activeSession: null,
        maxRunCostUsd: options.maxRunCostUsd ?? DEFAULT_STRESS_RUN_BUDGET.maxCostUsd,
        log,
    };

    const onInterrupt = () => {
        log('interrupted; stopping the active Electron session');
        void (context.activeSession?.stop() ?? Promise.resolve()).finally(() => {
            void writeStressRunJson(runDir, run).finally(() => process.exit(130));
        });
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);

    try {
        try {
            context.activeSession = await startStressSession('calibration', profile, log);
            run.calibration = await calibrate(context.activeSession, fixtures, log);
        } catch (error) {
            log(`calibration failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            await context.activeSession?.stop();
            context.activeSession = null;
        }
        await writeStressRunJson(runDir, run);
        const calibrationBlocker = calibrationBlocksStressRun(run.calibration);
        if (options.calibrateOnly || calibrationBlocker) {
            run.finishedAt = new Date().toISOString();
            run.verdict = calibrationBlocker ? 'failed' : 'passed';
            await writeStressRunJson(runDir, run);
            await writeFile(join(runDir, 'summary.md'), renderStressSummaryMarkdown(run), 'utf8');
            if (calibrationBlocker) {
                log(`host profile ${profile.id} not honoured; scenarios not run: ${calibrationBlocker}`);
            }
            return calibrationBlocker ? 1 : 0;
        }

        const baselinePath = stressBaselinePath(profile.id);
        const baseline = await readStressBaseline(baselinePath);
        if (!baseline) {
            log(`no baseline at ${baselinePath}; regression comparison skipped`);
        }

        for (const scenario of scenarios) {
            const elapsed = Date.now() - context.runStartedAt;
            if (elapsed > DEFAULT_STRESS_RUN_BUDGET.deadlineMs || (options.operatorProfile !== 'external' && context.runCostUsd >= context.maxRunCostUsd)) {
                run.scenarios.push({
                    id: scenario.id,
                    kind: scenario.kind,
                    status: 'skipped',
                    startedAt: new Date().toISOString(),
                    durationMs: 0,
                    profileId: profile.id,
                    findings: [],
                    metrics: null,
                    steps: [],
                    operator: null,
                    artifacts: {},
                    infraError: elapsed > DEFAULT_STRESS_RUN_BUDGET.deadlineMs ? 'run deadline passed' : 'run cost cap reached',
                });
                continue;
            }
            const result = await runScenario(context, scenario);
            if (baseline) {
                applyBaselineFindings(result, compareStressResultWithBaseline(baseline, result));
            }
            run.scenarios.push(result);
            run.totals = computeStressRunTotals(run.scenarios);
            await writeStressRunJson(runDir, run);
        }

        run.finishedAt = new Date().toISOString();
        run.totals = computeStressRunTotals(run.scenarios);
        run.verdict = resolveStressRunVerdict(run);
        const runJsonPath = await writeStressRunJson(runDir, run);
        const summaryPath = join(runDir, 'summary.md');
        await writeFile(summaryPath, renderStressSummaryMarkdown(run), 'utf8');
        log(`verdict ${run.verdict}: ${run.totals.passed} passed, ${run.totals.failed} failed, ${run.totals.infraFailed} infra-failed, ${run.totals.skipped} skipped, operator spend $${run.totals.costUsd.toFixed(2)}`);
        log(`run.json: ${runJsonPath}`);
        log(`summary: ${summaryPath}`);

        if (options.updateBaseline) {
            if (run.verdict !== 'passed') {
                log(`baseline not updated: run verdict ${run.verdict}`);
                return 1;
            }
            const next = updateStressBaseline(baseline ?? createEmptyStressBaseline(profile.id), run);
            await writeStressBaseline(baselinePath, next);
            log(`baseline updated: ${baselinePath}`);
        }
        return run.verdict === 'passed' ? 0 : 1;
    } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
    }
}

if (isStressCliEntrypoint(import.meta.url)) {
    void runStressCliMain(runStress);
}
