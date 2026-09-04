import {
    collectStressAppState,
    hashStressAppState,
} from '@scripts/stress/stressAppState';
import { executeStressOperatorTool } from '@scripts/stress/stressOperatorToolExecutor';
import type { IStressOperatorToolContext } from '@scripts/stress/stressOperatorToolExecutor';
import type { IStressActionRecord } from '@scripts/stress/stressTypes';

export interface IStressReplayStep {
    seq: number;
    tool: string;
    toolsetName: string | null;
    input: Record<string, unknown>;
    expectedAppStateSha256: string | null;
}

export interface IStressReplayDivergence {
    seq: number;
    tool: string;
    kind: 'tool-error' | 'state-mismatch';
    detail: string;
}

export interface IStressReplayResult {
    executed: number;
    divergences: IStressReplayDivergence[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionRecord(value: unknown): value is IStressActionRecord {
    if (!isPlainObject(value)) {
        return false;
    }
    return typeof value.seq === 'number'
        && typeof value.tool === 'string'
        && typeof value.status === 'string'
        && isPlainObject(value.input)
        && (value.toolsetName === null || typeof value.toolsetName === 'string');
}

function parseJsonLine(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * `actions.jsonl` holds two lines per action (running, then final). The
 * final line wins; interrupted actions are dropped because their effect on
 * the app is unknown; `report` is skipped because it has no UI effect. A
 * line the runner never finished writing (killed mid-write) is ignored so a
 * truncated log still replays up to the last complete action.
 */
export function parseReplayActions(raw: string) {
    const bySeq = new Map<number, IStressActionRecord>();
    for (const line of raw.split('\n')) {
        if (line.trim().length === 0) {
            continue;
        }
        const parsed = parseJsonLine(line);
        if (isActionRecord(parsed)) {
            bySeq.set(parsed.seq, parsed);
        }
    }
    return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function planReplaySteps(records: readonly IStressActionRecord[]): IStressReplayStep[] {
    return records
        .filter(record => record.status !== 'interrupted' && record.status !== 'running')
        .filter(record => !(record.status === 'failed' && record.error?.startsWith('Not executed')))
        .filter(record => record.tool !== 'report')
        .map(record => ({
            seq: record.seq,
            tool: record.tool,
            toolsetName: record.toolsetName,
            input: record.input,
            expectedAppStateSha256: record.evidence?.appStateSha256 ?? null,
        }));
}

/**
 * Replays actions against a live app and compares the structured app state
 * hash after each one. Screenshot hashes are never compared: anti-aliasing
 * and cursor blink make them differ on every run.
 */
export async function replayStressActions(steps: readonly IStressReplayStep[], context: IStressOperatorToolContext, log: (line: string) => void): Promise<IStressReplayResult> {
    const divergences: IStressReplayDivergence[] = [];
    let executed = 0;
    for (const step of steps) {
        log(`replay ${step.seq} ${step.tool}`);
        const execution = await executeStressOperatorTool(context, {
            toolsetName: step.toolsetName,
            name: step.tool,
            input: step.input,
        });
        executed += 1;
        if (execution.isError) {
            divergences.push({
                seq: step.seq,
                tool: step.tool,
                kind: 'tool-error',
                detail: typeof execution.content === 'string' ? execution.content : 'tool failed',
            });
            continue;
        }
        if (step.expectedAppStateSha256) {
            const state = await collectStressAppState(context.session.page).catch(() => null);
            const actual = state ? hashStressAppState(state) : null;
            if (actual !== step.expectedAppStateSha256) {
                divergences.push({
                    seq: step.seq,
                    tool: step.tool,
                    kind: 'state-mismatch',
                    detail: `expected app state ${step.expectedAppStateSha256.slice(0, 12)}, got ${actual?.slice(0, 12) ?? 'none'} (page ${state?.currentPage ?? '?'}/${state?.totalPages ?? '?'}, zoom ${state?.zoomPercent ?? '?'})`,
                });
            }
        }
    }
    return {
        executed,
        divergences,
    };
}
