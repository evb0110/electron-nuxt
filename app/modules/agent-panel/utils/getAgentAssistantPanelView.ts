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

    if (status.installState !== 'installed') {
        return 'install';
    }

    if (status.provider === 'codex' && !status.codexVersionSupported) {
        return 'update';
    }

    if (status.runtimeState === 'starting') {
        return 'checking';
    }

    if (status.runtimeState === 'error') {
        return 'error';
    }

    if (status.authState === 'unknown') {
        return 'checking';
    }

    if (status.authState === 'signed-in') {
        return 'ready';
    }

    return 'sign-in';
}
