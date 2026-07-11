import type {
    IAgentAssistantTurnState,
    TAgentAssistantRuntimeState,
} from '@contracts/agent';

export interface IAssistantSelectionLockState {
    isSending: boolean;
    runtimeState: TAgentAssistantRuntimeState;
    turn: IAgentAssistantTurnState;
}

export function isAssistantSelectionLocked(state: IAssistantSelectionLockState) {
    return state.isSending
        || state.runtimeState === 'busy'
        || state.turn.phase === 'queued'
        || state.turn.phase === 'thinking'
        || state.turn.phase === 'streaming'
        || state.turn.phase === 'tool-running'
        || state.turn.phase === 'finalizing'
        || state.turn.phase === 'stalled'
        || state.turn.phase === 'interrupting';
}
