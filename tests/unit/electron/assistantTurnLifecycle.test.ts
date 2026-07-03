import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canCompleteAssistantTurnWithoutProviderTurn,
    claimAssistantTurn,
    completeAssistantTurn,
    createInitialAssistantTurnOwner,
    getAssistantTurnPhase,
    getAssistantTurnProviderTurnId,
    isAssistantTurnActive,
    markAssistantTurnInterrupting,
    markAssistantTurnRunning,
    supersedeAssistantTurn,
    type IAssistantSessionScopeBinding,
} from '@electron/features/agent/assistantTurnLifecycle';

const scopeBinding = {
    sessionKey: 'codex:document:/tmp/a.pdf',
    provider: 'codex',
    windowId: 42,
    tabId: 'tab-a',
    documentRef: '/tmp/a.pdf',
    documentIdentity: null,
} satisfies Omit<IAssistantSessionScopeBinding, 'turnGeneration'>;

describe('assistant turn lifecycle', () => {
    it('claims turns with monotonically increasing generations', () => {
        const initial = createInitialAssistantTurnOwner();
        const first = claimAssistantTurn(initial, scopeBinding, 'local-1');
        const second = claimAssistantTurn(first, scopeBinding, 'local-2');

        expect(first).toMatchObject({
            phase: 'starting',
            generation: 1,
            localTurnId: 'local-1',
            providerTurnId: null,
            scope: {
                ...scopeBinding,
                turnGeneration: 1,
            },
        });
        expect(second).toMatchObject({
            phase: 'starting',
            generation: 2,
            localTurnId: 'local-2',
            scope: {
                ...scopeBinding,
                turnGeneration: 2,
            },
        });
    });

    it('drops stale starts and completions by generation and provider turn', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const staleStart = markAssistantTurnRunning(claimed, claimed.generation - 1, 'turn-old');
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        const wrongCompletion = completeAssistantTurn(running, running.generation, 'turn-2');
        const staleCompletion = completeAssistantTurn(running, running.generation - 1, 'turn-1');
        const completed = completeAssistantTurn(running, running.generation, 'turn-1');

        expect(staleStart).toBe(claimed);
        expect(wrongCompletion).toBe(running);
        expect(staleCompletion).toBe(running);
        expect(completed.phase).toBe('idle');
        expect(completed.generation).toBe(running.generation);
    });

    it('accepts providerless completion only for running or interrupting turns', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const startingCompletion = completeAssistantTurn(claimed, claimed.generation, null);
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        const runningCompletion = completeAssistantTurn(running, running.generation, null);

        expect(canCompleteAssistantTurnWithoutProviderTurn(claimed)).toBe(false);
        expect(startingCompletion).toBe(claimed);
        expect(canCompleteAssistantTurnWithoutProviderTurn(running)).toBe(true);
        expect(runningCompletion.phase).toBe('idle');
    });

    it('supersedes interrupted turns so stale completions cannot clear the next generation', () => {
        const claimed = claimAssistantTurn(createInitialAssistantTurnOwner(), scopeBinding, 'local-1');
        const running = markAssistantTurnRunning(claimed, claimed.generation, 'turn-1');
        const interrupting = markAssistantTurnInterrupting(running);
        const superseded = supersedeAssistantTurn(interrupting);
        const staleCompletion = completeAssistantTurn(superseded, running.generation, 'turn-1');

        expect(interrupting).toMatchObject({
            phase: 'interrupting',
            providerTurnId: 'turn-1',
        });
        expect(superseded).toMatchObject({
            phase: 'idle',
            generation: running.generation + 1,
        });
        expect(staleCompletion).toBe(superseded);
        expect(isAssistantTurnActive(superseded)).toBe(false);
        expect(getAssistantTurnProviderTurnId(superseded)).toBeNull();
        expect(getAssistantTurnPhase(superseded)).toBe('idle');
    });
});
