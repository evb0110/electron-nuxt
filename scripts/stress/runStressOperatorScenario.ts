import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type {
    ContentBlockParam,
    Message,
    MessageParam,
    ToolResultBlockParam,
    ToolUnion,
    ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import {
    collectStressAppState,
    hashStressAppState,
} from '@scripts/stress/stressAppState';
import type { IStressMetricsSampler } from '@scripts/stress/stressMetricsSampler';
import {
    FREEZE_STREAK_THRESHOLD,
    NOT_EXECUTED_TEXT,
    buildToolResult,
    createFreezeDetector,
    decideStressHalt,
    planToolCallBatch,
    pruneScreenshotHistory,
} from '@scripts/stress/stressOperatorConversation';
import {
    createStressCostLedger,
    toStressUsageRecord,
} from '@scripts/stress/stressOperatorCost';
import { executeStressOperatorTool } from '@scripts/stress/stressOperatorToolExecutor';
import type { IStressOperatorToolContext } from '@scripts/stress/stressOperatorToolExecutor';
import {
    COMPUTER_TOOLSET_TYPE,
    buildOperatorSystemPrompt,
    buildOperatorTaskCard,
    buildOperatorToolDefinitions,
} from '@scripts/stress/stressOperatorToolSchemas';
import type {
    IStressActionEvidence,
    IStressActionRecord,
    IStressBudgets,
    IStressOperatorReport,
    IStressOperatorScenario,
    TStressOperatorProfile,
} from '@scripts/stress/stressTypes';

export interface IStressOperatorDriverOptions {
    scenario: IStressOperatorScenario;
    runId: string;
    model: string;
    operatorProfile: TStressOperatorProfile;
    budgets: IStressBudgets;
    runCost: {
        totalUsd: () => number;
        maxUsd: number;
    };
    filePaths: string[];
    toolContext: IStressOperatorToolContext;
    sampler: IStressMetricsSampler | null;
    scenarioDir: string;
    enableThinking: boolean;
    log: (line: string) => void;
    client?: Anthropic;
}

export interface IStressOperatorDriverResult {
    turns: number;
    actions: number;
    costUsd: number | null;
    report: IStressOperatorReport | null;
    stopReason: string;
    frozenScreenshotStreak: number;
    actionRecords: IStressActionRecord[];
    artifacts: Record<string, string>;
}

const MAX_OUTPUT_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 4;

function readApiErrorStatus(error: unknown) {
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
        return error.status;
    }
    return undefined;
}

function jsonLine(stream: WriteStream, value: unknown) {
    stream.write(`${JSON.stringify(value)}\n`);
}

/** Transcript lines keep every message but swap base64 image data for a hash so files stay small. */
function sanitizeForTranscript(content: string | ContentBlockParam[] | Message['content']) {
    if (typeof content === 'string') {
        return content;
    }
    return content.map(block => {
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
            return {
                ...block,
                content: block.content.map(part => {
                    if (part.type === 'image' && part.source.type === 'base64') {
                        return {
                            type: 'image_ref',
                            bytes: Math.floor(part.source.data.length * 3 / 4),
                        };
                    }
                    return part;
                }),
            };
        }
        return block;
    });
}

function buildTools(profile: TStressOperatorProfile): ToolUnion[] {
    const custom: ToolUnion[] = buildOperatorToolDefinitions(profile).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
    }));
    if (profile === 'pixel') {
        custom.unshift({type: COMPUTER_TOOLSET_TYPE});
    }
    return custom;
}

async function collectEvidence(context: IStressOperatorToolContext, sampler: IStressMetricsSampler | null, screenshot: {
    sha256: string;
    path: string;
    width: number;
    height: number
} | null): Promise<IStressActionEvidence> {
    const state = await collectStressAppState(context.session.page).catch(() => null);
    const counters = sampler?.counters() ?? {
        consoleErrorCount: 0,
        pageErrorCount: 0,
        rendererCrashed: false,
    };
    const last = sampler?.lastSample() ?? null;
    return {
        screenshotSha256: screenshot?.sha256 ?? null,
        screenshotPath: screenshot?.path ?? null,
        width: screenshot?.width ?? null,
        height: screenshot?.height ?? null,
        appStateSha256: state ? hashStressAppState(state) : null,
        appState: state,
        consoleErrorCount: counters.consoleErrorCount,
        pageErrorCount: counters.pageErrorCount,
        rendererCrashed: counters.rendererCrashed,
        rssBytes: last?.rssBytesTotal ?? null,
        jsHeapUsedBytes: last?.jsHeapUsedBytes ?? null,
        maxFrameGapMs: last?.probe?.frameMaxGapMs ?? null,
    };
}

/**
 * Messages API loop: one assistant turn, execute up to four tool calls, feed
 * results back, repeat until `report`, a budget guard, or the model stops
 * calling tools. Every tool call becomes an `actions.jsonl` line before it
 * runs and again after, so a killed run still shows what was in flight.
 */
export async function runStressOperatorScenario(options: IStressOperatorDriverOptions): Promise<IStressOperatorDriverResult> {
    const {
        scenario,
        model,
        operatorProfile,
        budgets,
        toolContext,
        sampler,
        log,
    } = options;
    const client = options.client ?? new Anthropic({
        maxRetries: MAX_RETRIES,
        timeout: REQUEST_TIMEOUT_MS,
    });
    const screenshotsDir = join(options.scenarioDir, 'screenshots');
    await mkdir(screenshotsDir, {recursive: true});
    const transcriptPath = join(options.scenarioDir, 'transcript.jsonl');
    const actionsPath = join(options.scenarioDir, 'actions.jsonl');
    const transcript = createWriteStream(transcriptPath, {flags: 'w'});
    const actions = createWriteStream(actionsPath, {flags: 'w'});
    transcript.on('error', error => log(`transcript write failed: ${error.message}`));
    actions.on('error', error => log(`actions write failed: ${error.message}`));
    const ledger = createStressCostLedger();
    const freeze = createFreezeDetector();
    const startedAt = Date.now();
    const actionRecords: IStressActionRecord[] = [];
    const tools = buildTools(operatorProfile);
    const system = buildOperatorSystemPrompt(operatorProfile, budgets.maxTurns);
    const taskCard = buildOperatorTaskCard(scenario.id, scenario.taskCard, options.filePaths, budgets.maxTurns);
    await writeFile(join(options.scenarioDir, 'task-card.txt'), `${taskCard}\n`, 'utf8');

    let messages: MessageParam[] = [{
        role: 'user',
        content: taskCard,
    }];
    jsonLine(transcript, {
        turn: 0,
        role: 'user',
        content: taskCard,
    });

    let turn = 0;
    let seq = 0;
    let report: IStressOperatorReport | null = null;
    let stopReason = 'unknown';
    let pendingStateChange = false;
    let nudgedForReport = false;

    const finish = () => {
        return {
            turns: turn,
            actions: actionRecords.length,
            costUsd: ledger.totalKnown() ? ledger.totalUsd() : null,
            report,
            stopReason,
            frozenScreenshotStreak: freeze.streak(),
            actionRecords,
            artifacts: {
                transcript: transcriptPath,
                actions: actionsPath,
                taskCard: join(options.scenarioDir, 'task-card.txt'),
            },
        };
    };

    const runTurns = async () => {
        while (true) {
            const halt = decideStressHalt({
                turn,
                maxTurns: budgets.maxTurns,
                costUsd: ledger.totalUsd(),
                costKnown: ledger.totalKnown(),
                maxCostUsd: budgets.maxCostUsd,
                elapsedMs: Date.now() - startedAt,
                deadlineMs: budgets.deadlineMs,
                runCostUsd: options.runCost.totalUsd() + ledger.totalUsd(),
                runMaxCostUsd: options.runCost.maxUsd,
                freezeStreak: freeze.streak(),
                rendererCrashed: sampler?.counters().rendererCrashed ?? false,
            });
            if (halt.halt) {
                stopReason = halt.reason ?? 'halted';
                log(`operator halted: ${stopReason}`);
                return finish();
            }

            turn += 1;
            messages = pruneScreenshotHistory(messages);
            let response: Message;
            try {
                response = await client.messages.create({
                    model,
                    max_tokens: MAX_OUTPUT_TOKENS,
                    system,
                    tools,
                    messages,
                    ...(options.enableThinking ? {thinking: {type: 'adaptive' as const}} : {}),
                });
            } catch (error) {
                const status = readApiErrorStatus(error);
                stopReason = `api error${status ? ` ${status}` : ''}: ${error instanceof Error ? error.message : String(error)}`;
                log(`operator ${stopReason}`);
                return finish();
            }
            const usage = toStressUsageRecord(model, response.usage);
            ledger.add(usage);
            log(`turn ${turn}: stop=${response.stop_reason} in=${usage.inputTokens} out=${usage.outputTokens} cost=${usage.costUsd === null ? '?' : `$${usage.costUsd.toFixed(3)}`}`);

            messages.push({
                role: 'assistant',
                content: response.content,
            });
            jsonLine(transcript, {
                turn,
                role: 'assistant',
                stopReason: response.stop_reason,
                usage,
                content: sanitizeForTranscript(response.content),
            });

            const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
            if (toolUses.length === 0) {
                if (response.stop_reason === 'max_tokens') {
                    stopReason = 'model hit max_tokens without a tool call';
                    return finish();
                }
                if (!nudgedForReport) {
                    nudgedForReport = true;
                    const nudge = 'You stopped without calling report. Call report now with what you verified.';
                    messages.push({
                        role: 'user',
                        content: nudge,
                    });
                    jsonLine(transcript, {
                        turn,
                        role: 'user',
                        content: nudge,
                    });
                    continue;
                }
                stopReason = 'model ended the turn without calling report';
                return finish();
            }

            const results: ToolResultBlockParam[] = [];
            let batchFailed = false;
            for (const [
                batchIndex,
                planned,
            ] of planToolCallBatch(toolUses).entries()) {
                const call = planned.call;
                const toolsetName = call.toolset_name ?? null;
                seq += 1;
                const record: IStressActionRecord = {
                    seq,
                    turn,
                    batchIndex,
                    runId: options.runId,
                    scenarioId: scenario.id,
                    toolUseId: call.id,
                    toolsetName,
                    tool: call.name,
                    input: typeof call.input === 'object' && call.input !== null ? call.input as Record<string, unknown> : {},
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    completedAt: null,
                    durationMs: null,
                    tOffsetMs: Date.now() - startedAt,
                    error: null,
                    evidence: null,
                    ...(batchIndex === 0 && usage ? {usage} : {}),
                };
                if (!planned.execute || batchFailed) {
                    record.status = 'failed';
                    record.error = planned.skipReason ?? NOT_EXECUTED_TEXT;
                    record.completedAt = record.startedAt;
                    record.durationMs = 0;
                    actionRecords.push(record);
                    jsonLine(actions, record);
                    results.push(buildToolResult(call.id, record.error, true, toolsetName));
                    continue;
                }
                jsonLine(actions, record);
                const actionStart = Date.now();
                const execution = await executeStressOperatorTool(toolContext, {
                    toolsetName,
                    name: call.name,
                    input: call.input,
                });
                record.durationMs = Date.now() - actionStart;
                record.completedAt = new Date().toISOString();
                record.status = execution.isError ? 'failed' : 'succeeded';
                record.error = execution.isError && typeof execution.content === 'string' ? execution.content : null;

                let screenshotRef: {
                    sha256: string;
                    path: string;
                    width: number;
                    height: number
                } | null = null;
                if (execution.screenshot) {
                    const path = join(screenshotsDir, `${String(seq).padStart(4, '0')}-${call.name}.png`);
                    await writeFile(path, execution.screenshot.png);
                    screenshotRef = {
                        sha256: execution.screenshot.sha256,
                        path,
                        width: execution.screenshot.width,
                        height: execution.screenshot.height,
                    };
                    const streak = freeze.observe(execution.screenshot.sha256, pendingStateChange);
                    pendingStateChange = false;
                    if (streak >= FREEZE_STREAK_THRESHOLD) {
                        log(`screenshot unchanged after ${streak} state-changing actions`);
                    }
                }
                if (execution.stateChanging && !execution.isError) {
                    pendingStateChange = true;
                }
                record.evidence = await collectEvidence(toolContext, sampler, screenshotRef);
                actionRecords.push(record);
                jsonLine(actions, record);
                log(`  ${call.name}${toolsetName ? ` (${toolsetName})` : ''} ${record.status} in ${record.durationMs}ms`);

                results.push(buildToolResult(call.id, execution.content, execution.isError, toolsetName));
                if (execution.isError) {
                    batchFailed = true;
                }
                if (execution.report) {
                    report = execution.report;
                }
            }

            messages.push({
                role: 'user',
                content: results,
            });
            jsonLine(transcript, {
                turn,
                role: 'user',
                content: sanitizeForTranscript(results),
            });

            if (report) {
                stopReason = `report: ${report.outcome}`;
                return finish();
            }
        }
    };

    try {
        return await runTurns();
    } finally {
        await Promise.all([
            new Promise<void>(resolve => transcript.end(resolve)),
            new Promise<void>(resolve => actions.end(resolve)),
        ]);
    }
}
