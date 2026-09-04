import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    FREEZE_STREAK_THRESHOLD,
    NOT_EXECUTED_TEXT,
    buildToolResult,
    createFreezeDetector,
    decideStressHalt,
    planToolCallBatch,
    pruneScreenshotHistory,
} from '@scripts/stress/stressOperatorConversation';
import type { IStressHaltInput } from '@scripts/stress/stressOperatorConversation';

function imageResult(id: string): MessageParam {
    return {
        role: 'user',
        content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: [
                {
                    type: 'text',
                    text: `shot ${id}`,
                },
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: 'AAAA',
                    },
                },
            ],
        }],
    };
}

function countImages(messages: MessageParam[]) {
    let images = 0;
    for (const message of messages) {
        if (typeof message.content === 'string') {
            continue;
        }
        for (const block of message.content) {
            if (block.type === 'tool_result' && Array.isArray(block.content)) {
                images += block.content.filter(part => part.type === 'image').length;
            }
        }
    }
    return images;
}

describe('pruneScreenshotHistory', () => {
    it('keeps only the newest screenshots and leaves text results alone', () => {
        const messages: MessageParam[] = [
            {
                role: 'user',
                content: 'task card',
            },
            imageResult('a'),
            {
                role: 'assistant',
                content: 'ok',
            },
            imageResult('b'),
            imageResult('c'),
            imageResult('d'),
        ];
        const pruned = pruneScreenshotHistory(messages, 2);
        expect(countImages(pruned)).toBe(2);
        expect(countImages(messages)).toBe(4);
        expect(pruned).toHaveLength(messages.length);
        const first = pruned[1];
        expect(first && typeof first.content !== 'string' && first.content[0]?.type === 'tool_result' && Array.isArray(first.content[0].content)
            ? first.content[0].content.map(part => (part.type === 'text' ? part.text : part.type))
            : null).toEqual([
            'shot a',
            '[earlier screenshot removed to save context; take a new one if needed]',
        ]);
    });
});

describe('createFreezeDetector', () => {
    it('counts identical screenshots only after state-changing actions', () => {
        const detector = createFreezeDetector();
        expect(detector.observe('h1', true)).toBe(1);
        expect(detector.observe('h1', true)).toBe(2);
        expect(detector.observe('h1', false)).toBe(2);
        expect(detector.observe('h1', true)).toBe(3);
        expect(detector.observe('h2', true)).toBe(1);
        detector.observe('h2', true);
        detector.reset();
        expect(detector.streak()).toBe(0);
    });
});

describe('decideStressHalt', () => {
    const base: IStressHaltInput = {
        turn: 1,
        maxTurns: 40,
        costUsd: 0.1,
        costKnown: true,
        maxCostUsd: 2.5,
        elapsedMs: 1000,
        deadlineMs: 60_000,
        runCostUsd: 1,
        runMaxCostUsd: 40,
        freezeStreak: 0,
        rendererCrashed: false,
    };

    it('continues while every guard is within budget', () => {
        expect(decideStressHalt(base)).toEqual({
            halt: false,
            reason: null,
        });
    });

    it('halts on each guard with a specific reason', () => {
        expect(decideStressHalt({
            ...base,
            rendererCrashed: true,
        }).reason).toMatch(/crashed/u);
        expect(decideStressHalt({
            ...base,
            turn: 40,
        }).reason).toMatch(/turn budget/u);
        expect(decideStressHalt({
            ...base,
            costUsd: 2.5,
        }).reason).toMatch(/scenario cost/u);
        expect(decideStressHalt({
            ...base,
            runCostUsd: 40,
        }).reason).toMatch(/run cost/u);
        expect(decideStressHalt({
            ...base,
            elapsedMs: 60_000,
        }).reason).toMatch(/deadline/u);
        expect(decideStressHalt({
            ...base,
            freezeStreak: FREEZE_STREAK_THRESHOLD + 2,
        }).reason).toMatch(/identical screenshots/u);
        expect(decideStressHalt({
            ...base,
            freezeStreak: FREEZE_STREAK_THRESHOLD,
        }).halt).toBe(false);
    });

    it('ignores cost caps when the model is unpriced', () => {
        expect(decideStressHalt({
            ...base,
            costKnown: false,
            costUsd: 99,
            runCostUsd: 99,
        }).halt).toBe(false);
    });
});

describe('planToolCallBatch and buildToolResult', () => {
    it('executes only the first N calls of a turn', () => {
        const planned = planToolCallBatch([
            'a',
            'b',
            'c',
        ], 2);
        expect(planned.map(item => item.execute)).toEqual([
            true,
            true,
            false,
        ]);
        expect(planned[2]?.skipReason).toContain('more than 2');
    });

    it('marks errors and toolset membership on tool results', () => {
        expect(buildToolResult('t1', NOT_EXECUTED_TEXT, true, 'computer')).toEqual({
            type: 'tool_result',
            tool_use_id: 't1',
            content: NOT_EXECUTED_TEXT,
            is_error: true,
            toolset_name: 'computer',
        });
        expect(buildToolResult('t2', 'OK', false, null)).toEqual({
            type: 'tool_result',
            tool_use_id: 't2',
            content: 'OK',
        });
    });
});
