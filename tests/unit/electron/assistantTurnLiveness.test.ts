import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveAssistantTurnLiveness } from '@electron/features/agent/assistantTurnLiveness';

describe('assistant turn liveness', () => {
    it('stalls an active phase after a full provider-silence threshold', () => {
        expect(resolveAssistantTurnLiveness('thinking', 1_000, 1_999, 1_000)).toBe('thinking');
        expect(resolveAssistantTurnLiveness('thinking', 1_000, 2_000, 1_000)).toBe('stalled');
    });

    it.each([
        'idle',
        'done',
        'failed',
        'cancelled',
    ] as const)('never stalls terminal phase %s', phase => {
        expect(resolveAssistantTurnLiveness(phase, 0, 100_000, 1)).toBe(phase);
    });
});
