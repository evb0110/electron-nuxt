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
        || state.turn.phase === 'starting'
        || state.turn.phase === 'running'
        || state.turn.phase === 'interrupting';
}
