import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IAssistantSelectionLockState } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';
import { isAssistantSelectionLocked } from '@app/modules/agent-panel/utils/isAssistantSelectionLocked';

const idleState: IAssistantSelectionLockState = {
    activeTurnId: null,
    isSending: false,
    runtimeState: 'ready',
    turnPhase: 'idle',
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
            name: 'backend reports an active turn id',
            patch: {activeTurnId: 'turn-1'},
        },
        {
            name: 'turn is starting',
            patch: {turnPhase: 'starting' as const},
        },
        {
            name: 'turn is running',
            patch: {turnPhase: 'running' as const},
        },
        {
            name: 'turn is interrupting',
            patch: {turnPhase: 'interrupting' as const},
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
            turnPhase: 'error',
        })).toBe(false);
    });
});
