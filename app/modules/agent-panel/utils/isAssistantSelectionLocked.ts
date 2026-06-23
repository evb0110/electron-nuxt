import type {
    TAgentAssistantRuntimeState,
    TAgentAssistantTurnPhase,
} from '@contracts/agent';

export interface IAssistantSelectionLockState {
    activeTurnId: string | null;
    isSending: boolean;
    runtimeState: TAgentAssistantRuntimeState;
    turnPhase: TAgentAssistantTurnPhase;
}

export function isAssistantSelectionLocked(state: IAssistantSelectionLockState) {
    return state.isSending
        || state.runtimeState === 'busy'
        || Boolean(state.activeTurnId)
        || state.turnPhase === 'starting'
        || state.turnPhase === 'running'
        || state.turnPhase === 'interrupting';
}
