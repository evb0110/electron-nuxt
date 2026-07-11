import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAssistantSelectionLockState } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';
import { isAssistantSelectionLocked } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';

const idleState: IAssistantSelectionLockState = {
    isSending: false,
    runtimeState: 'ready',
    turn: {
        id: null,
        phase: 'idle',
        reasoning: '',
        toolActivity: [],
        lastEventAtMs: null,
        usage: null,
    },
};
const startingTurn = {
    id: null,
    phase: 'queued' as const,
    reasoning: '',
    toolActivity: [],
    lastEventAtMs: Date.now(),
    usage: null,
};
const runningTurn = {
    id: 'turn-1',
    phase: 'thinking' as const,
    reasoning: '',
    toolActivity: [],
    lastEventAtMs: Date.now(),
    usage: null,
};
const interruptingTurn = {
    id: 'turn-1',
    phase: 'interrupting' as const,
    reasoning: '',
    toolActivity: [],
    lastEventAtMs: Date.now(),
    usage: null,
};

describe('assistantSelectionLock', () => {
    it('leaves selection unlocked only for idle assistant state', () => {
        expect(isAssistantSelectionLocked(idleState)).toBe(false);
    });

    it.each([
        {
            name: 'local send is in flight',
            patch: {isSending: true},
        },
        {
            name: 'backend runtime is busy',
            patch: {runtimeState: 'busy' as const},
        },
        {
            name: 'turn is starting',
            patch: {turn: startingTurn},
        },
        {
            name: 'turn is running',
            patch: {turn: runningTurn},
        },
        {
            name: 'turn is interrupting',
            patch: {turn: interruptingTurn},
        },
    ])('locks selection while $name', ({patch}) => {
        expect(isAssistantSelectionLocked({
            ...idleState,
            ...patch,
        })).toBe(true);
    });

    it('does not lock selection for stopped or errored idle states', () => {
        expect(isAssistantSelectionLocked({
            ...idleState,
            runtimeState: 'stopped',
        })).toBe(false);
        expect(isAssistantSelectionLocked({
            ...idleState,
            runtimeState: 'error',
            turn: {
                id: null,
                phase: 'failed',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: Date.now(),
                usage: null,
            },
        })).toBe(false);
    });
});
