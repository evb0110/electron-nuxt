import { randomUUID } from 'node:crypto';
import {
    lstat,
    realpath,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import { isJsonRecord } from '@scripts/electron-run/isJsonRecord';
import type { IStressOperatorReport } from '@scripts/stress/stressTypes';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import { sessionFilePath } from '@scripts/electron-run/electronRunSessionPaths';
import { buildOperatorTaskCard } from '@scripts/stress/stressOperatorToolSchemas';
import type {
    IStressOperatorDriverOptions,
    IStressOperatorDriverResult,
} from '@scripts/stress/runStressOperatorScenario';

async function parseExternalReport(value: unknown, requestId: string, scenarioDir: string): Promise<{
    report: IStressOperatorReport;
    evidencePaths: string[]
}> {
    if (!isJsonRecord(value) || value.requestId !== requestId) {
        throw new Error('External operator report requestId does not match this session');
    }
    const {
        outcome,
        stepsDone,
        problem,
        slowestAction,
        finalPage,
        evidence = [],
    } = value;
    if (outcome !== 'completed' && outcome !== 'blocked' && outcome !== 'app_broken') {
        throw new Error('External operator report needs a valid outcome');
    }
    if (!Array.isArray(stepsDone) || (outcome === 'completed' && stepsDone.length === 0) || !stepsDone.every((step): step is string => typeof step === 'string' && step.trim().length > 0)
        || (problem !== null && typeof problem !== 'string')
        || (outcome !== 'completed' && (typeof problem !== 'string' || problem.trim().length === 0))
        || (slowestAction !== null && typeof slowestAction !== 'string')
        || (finalPage !== null && (typeof finalPage !== 'number' || !Number.isInteger(finalPage) || finalPage < 1))) {
        throw new Error('External operator report has invalid or missing fields');
    }
    if (!Array.isArray(evidence) || !evidence.every((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)) {
        throw new Error('External operator report evidence must be file paths');
    }
    const root = await realpath(scenarioDir);
    const evidencePaths: string[] = [];
    for (const entry of evidence) {
        const candidate = resolve(root, entry);
        const lexical = relative(root, candidate);
        if (isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`)) {
            throw new Error('External operator report evidence must stay inside the scenario directory');
        }
        const actual = await realpath(candidate);
        const nested = relative(root, actual);
        const info = await lstat(candidate);
        if (isAbsolute(nested) || nested === '..' || nested.startsWith(`..${sep}`) || !info.isFile() || info.size === 0) {
            throw new Error('External operator report evidence must be nonempty regular files inside the scenario directory');
        }
        evidencePaths.push(actual);
    }
    if (outcome === 'completed' && (!evidencePaths.some(path => /\.(?:png|jpe?g)$/iu.test(path)) || !evidencePaths.some(path => /\.(?:jsonl|txt|md)$/iu.test(path)))) {
        throw new Error('External operator report needs a screenshot and an action log for completion');
    }
    return {
        report: {
            outcome,
            stepsDone,
            problem,
            slowestAction,
            finalPage,
        },
        evidencePaths,
    };
}

/** The caller owns sampling and teardown while the existing agent operates the visible app. */
export async function runExternalStressOperator(options: IStressOperatorDriverOptions): Promise<IStressOperatorDriverResult> {
    const requestId = randomUUID();
    const taskPath = join(options.scenarioDir, 'task-card.txt');
    const requestPath = join(options.scenarioDir, 'operator-request.json');
    const reportPath = join(options.scenarioDir, `operator-report-${requestId}.json`);
    const info = getSessionInfo(options.toolContext.session.name);
    if (!info) {
        throw new Error('External operator session metadata is unavailable');
    }
    const deadline = options.deadlineAt ?? Date.now() + options.budgets.deadlineMs;
    const task = buildOperatorTaskCard(options.scenario.id, options.scenario.taskCard, options.filePaths, options.budgets.maxTurns);
    const instructions = [
        task,
        '',
        'Use your existing computer-use tools to operate this session. No API key is needed.',
        `Session: ${options.toolContext.session.name}`,
        `Electron PID: ${info.electronPid}`,
        `Session metadata: ${sessionFilePath(options.toolContext.session.name)}`,
        `CDP endpoint: http://127.0.0.1:${info.cdpPort}`,
        `Resolve the exact app target: node .agents/skills/evb-viewer-computer-use/scripts/resolve-target.mjs --session=${options.toolContext.session.name} --json`,
        'Select that exact app path or PID with computer use. Never select generic Electron by name.',
        'Open only the Files listed above. Save only those working copies. Leave other app sessions alone.',
        'The runner is collecting metrics. Do not stop it or change the host profile.',
        'Save screenshots and a chronological action log in this scenario directory. A completed report must list at least one image and the action log in evidence.',
        'Direct computer-use actions are not captured by stress:replay. Do not claim replay coverage.',
        `Deadline: ${new Date(deadline).toISOString()}`,
        `When finished, atomically write a JSON report to ${reportPath} using a temporary file and rename.`,
        'Report shape, replace the example values with what you actually verified:',
        JSON.stringify({
            requestId,
            outcome: 'completed',
            stepsDone: ['Describe each verified step'],
            problem: null,
            slowestAction: null,
            finalPage: null,
            evidence: [
                'screenshot.png',
                'operator-actions.jsonl',
            ],
        }),
        'Use outcome blocked or app_broken with a problem description when appropriate.',
        'If blocked before completing any step, use an empty stepsDone list and describe the attempted action in problem.',
    ].join('\n');
    await writeFile(taskPath, `${instructions}\n`, 'utf8');
    await writeFile(requestPath, `${JSON.stringify({
        requestId,
        runId: options.runId,
        scenarioId: options.scenario.id,
        sessionName: options.toolContext.session.name,
        electronPid: info.electronPid,
        cdpEndpoint: `http://127.0.0.1:${info.cdpPort}`,
        taskPath,
        reportPath,
        deadline: new Date(deadline).toISOString(),
        status: 'waiting',
    }, null, 2)}\n`, 'utf8');
    options.log(`EXTERNAL OPERATOR READY: ${requestPath}`);
    options.log(`Read ${taskPath}, operate the app, then write ${reportPath}`);
    let report: IStressOperatorDriverResult['report'] = null;
    const evidenceArtifacts: Record<string, string> = {};
    let stopReason = 'external operator deadline exceeded';
    try {
        while (Date.now() < deadline) {
            options.signal?.throwIfAborted();
            if (options.sampler?.counters().rendererCrashed) {
                stopReason = 'renderer crashed';
                break;
            }
            let raw: string | null = null;
            try {
                raw = await readFile(reportPath, 'utf8');
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                    throw error;
                }
            }
            if (raw !== null) {
                const parsed = await parseExternalReport(JSON.parse(raw), requestId, options.scenarioDir);
                report = parsed.report;
                for (const [
                    index,
                    path,
                ] of parsed.evidencePaths.entries()) {
                    evidenceArtifacts[`operatorEvidence${index + 1}`] = path;
                }
                stopReason = `report: ${report.outcome}`;
                break;
            }
            await delay(Math.min(250, Math.max(1, deadline - Date.now())));
        }
    } finally {
        // The task card remains evidence; this marker prevents a later agent using a closed session.
        await writeFile(requestPath, `${JSON.stringify({
            requestId,
            status: 'closed',
            taskPath,
            reportPath,
        }, null, 2)}\n`, 'utf8');
    }
    return {
        turns: 0,
        actions: 0,
        costUsd: null,
        report,
        stopReason,
        frozenScreenshotStreak: 0,
        actionRecords: [],
        artifacts: {
            ...evidenceArtifacts,
            taskCard: taskPath,
            operatorRequest: requestPath,
            ...(report ? { operatorReport: reportPath } : {}),
        },
    };
}
