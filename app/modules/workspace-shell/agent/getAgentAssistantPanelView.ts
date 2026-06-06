import type { IAgentAssistantStatus } from '@contracts/agent';

export function getAgentAssistantPanelView(
    status: IAgentAssistantStatus,
    hasLoadedState: boolean,
) {
    if (!hasLoadedState) {
        return 'checking';
    }

    if (!status.supported) {
        return 'unsupported';
    }

    if (!status.codexInstalled) {
        return 'install';
    }

    if (!status.codexVersionSupported) {
        return 'update';
    }

    if (status.runtimeState === 'starting' || status.authState === 'unknown') {
        return 'checking';
    }

    if (status.authState === 'signed-in') {
        return 'ready';
    }

    return 'sign-in';
}
