import type {
    ContentBlockParam,
    MessageParam,
    ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

export const NOT_EXECUTED_TEXT = 'Not executed: an earlier computer action in this turn failed.';
export const DEFAULT_SCREENSHOTS_TO_KEEP = 3;
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 4;
export const FREEZE_STREAK_THRESHOLD = 3;

const PRUNED_IMAGE_TEXT = '[earlier screenshot removed to save context; take a new one if needed]';

function isToolResultBlock(block: ContentBlockParam): block is ToolResultBlockParam {
    return block.type === 'tool_result';
}

function toolResultHasImage(block: ToolResultBlockParam) {
    return Array.isArray(block.content) && block.content.some(part => part.type === 'image');
}

/**
 * Screenshots dominate token cost. Keep the newest `keep` images and replace
 * older ones with a short note. Returns a new array; inputs are not mutated.
 */
export function pruneScreenshotHistory(messages: readonly MessageParam[], keep = DEFAULT_SCREENSHOTS_TO_KEEP) {
    let seen = 0;
    const output: MessageParam[] = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }
        if (message.role !== 'user' || typeof message.content === 'string') {
            output.unshift(message);
            continue;
        }
        const content: ContentBlockParam[] = [];
        for (const block of [...message.content].reverse()) {
            if (isToolResultBlock(block) && toolResultHasImage(block)) {
                seen += 1;
                if (seen > keep) {
                    const textParts = (Array.isArray(block.content) ? block.content : []).filter(part => part.type === 'text');
                    content.unshift({
                        ...block,
                        content: [
                            ...textParts,
                            {
                                type: 'text',
                                text: PRUNED_IMAGE_TEXT,
                            },
                        ],
                    });
                    continue;
                }
            }
            content.unshift(block);
        }
        output.unshift({
            ...message,
            content,
        });
    }
    return output;
}

export interface IFreezeDetector {
    observe: (screenshotSha256: string, afterStateChangingAction: boolean) => number;
    streak: () => number;
    reset: () => void;
}

/**
 * The streak counts identical screenshots in a row, each taken after a
 * state-changing action, so the first screenshot after such an action is a
 * streak of 1 and `FREEZE_STREAK_THRESHOLD` identical ones mean the UI stopped
 * repainting. Screenshots after read-only actions (zoom, cursor_position,
 * wait) do not count: a stable screen is expected then.
 */
export function createFreezeDetector(): IFreezeDetector {
    let lastHash: string | null = null;
    let streak = 0;
    return {
        observe(hash, afterStateChangingAction) {
            if (!afterStateChangingAction) {
                lastHash = hash;
                return streak;
            }
            streak = hash === lastHash ? streak + 1 : 1;
            lastHash = hash;
            return streak;
        },
        streak: () => streak,
        reset() {
            lastHash = null;
            streak = 0;
        },
    };
}

export interface IStressHaltDecision {
    halt: boolean;
    reason: string | null;
}

export interface IStressHaltInput {
    turn: number;
    maxTurns: number;
    costUsd: number;
    costKnown: boolean;
    maxCostUsd: number;
    elapsedMs: number;
    deadlineMs: number;
    runCostUsd: number;
    runMaxCostUsd: number;
    freezeStreak: number;
    rendererCrashed: boolean;
}

/** Pure budget policy; every guard from the research doc lives here so tests can pin it. */
export function decideStressHalt(input: IStressHaltInput): IStressHaltDecision {
    if (input.rendererCrashed) {
        return {
            halt: true,
            reason: 'renderer crashed',
        };
    }
    if (input.turn >= input.maxTurns) {
        return {
            halt: true,
            reason: `turn budget of ${input.maxTurns} exhausted`,
        };
    }
    if (input.costKnown && input.costUsd >= input.maxCostUsd) {
        return {
            halt: true,
            reason: `scenario cost $${input.costUsd.toFixed(2)} reached the $${input.maxCostUsd.toFixed(2)} cap`,
        };
    }
    if (input.costKnown && input.runCostUsd >= input.runMaxCostUsd) {
        return {
            halt: true,
            reason: `run cost $${input.runCostUsd.toFixed(2)} reached the $${input.runMaxCostUsd.toFixed(2)} cap`,
        };
    }
    if (input.elapsedMs >= input.deadlineMs) {
        return {
            halt: true,
            reason: `scenario deadline of ${Math.round(input.deadlineMs / 1000)}s passed`,
        };
    }
    if (input.freezeStreak >= FREEZE_STREAK_THRESHOLD + 2) {
        return {
            halt: true,
            reason: `${input.freezeStreak} identical screenshots after state-changing actions`,
        };
    }
    return {
        halt: false,
        reason: null,
    };
}

export interface IPlannedToolCall<T> {
    call: T;
    execute: boolean;
    skipReason: string | null;
}

/** Caps tool calls per assistant turn; calls past the cap are answered with an error result. */
export function planToolCallBatch<T>(calls: readonly T[], maxPerTurn = DEFAULT_MAX_TOOL_CALLS_PER_TURN): Array<IPlannedToolCall<T>> {
    return calls.map((call, index) => ({
        call,
        execute: index < maxPerTurn,
        skipReason: index < maxPerTurn ? null : `Not executed: more than ${maxPerTurn} tool calls in one turn.`,
    }));
}

export type TStressToolResultContent = NonNullable<ToolResultBlockParam['content']>;

export function buildToolResult(toolUseId: string, content: TStressToolResultContent, isError: boolean, toolsetName: string | null): ToolResultBlockParam {
    const block: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
    };
    if (isError) {
        block.is_error = true;
    }
    if (toolsetName) {
        block.toolset_name = toolsetName;
    }
    return block;
}
