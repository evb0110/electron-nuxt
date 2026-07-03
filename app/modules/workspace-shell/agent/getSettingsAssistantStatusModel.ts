import type { IAgentAssistantStatus } from '@contracts/agent';
import { getAgentAssistantPanelView } from '@app/modules/agent-panel/public/agentAssistantPanelView';

export type TSettingsAssistantAction = 'install' | 'update' | 'sign-in';
export type TSettingsAssistantActionLabelKey =
    | 'assistant.installCodex'
    | 'assistant.updateCodex'
    | 'assistant.signInChatGpt';
export type TSettingsAssistantStatusTone = 'neutral' | 'ready' | 'warning';
export type TSettingsAssistantStaticCopyKey =
    | 'assistant.loginPending'
    | 'settings.assistantPanelCheckingHint'
    | 'settings.assistantPanelNeedsCodexHint'
    | 'settings.assistantPanelReadyHint'
    | 'settings.assistantPanelSignedOutHint'
    | 'settings.assistantPanelStatusChecking'
    | 'settings.assistantPanelStatusLoginPending'
    | 'settings.assistantPanelStatusNeedsCodex'
    | 'settings.assistantPanelStatusNeedsUpdate'
    | 'settings.assistantPanelStatusReady'
    | 'settings.assistantPanelStatusSignedOut'
    | 'settings.assistantPanelStatusUnsupported'
    | 'settings.assistantPanelUnsupportedHint';

export type TSettingsAssistantCopy =
    | { key: TSettingsAssistantStaticCopyKey; }
    | {
        key: 'settings.assistantPanelNeedsUpdateHint';
        params: { version: string; };
    }
    | {
        key: 'settings.assistantPanelStatusReadyAccount';
        params: { account: string; };
    };

export interface ISettingsAssistantStatusModel {
    tone: TSettingsAssistantStatusTone;
    icon: string;
    label: TSettingsAssistantCopy;
    hint: TSettingsAssistantCopy;
    primaryAction: TSettingsAssistantAction | null;
    primaryActionLabelKey: TSettingsAssistantActionLabelKey | null;
    primaryActionIcon: string | null;
    showCancelLogin: boolean;
}

export function getSettingsAssistantStatusModel(
    status: IAgentAssistantStatus | null,
    hasLoadedState: boolean,
): ISettingsAssistantStatusModel {
    const panelView = status
        ? getAgentAssistantPanelView(status, hasLoadedState)
        : 'checking';

    // The assistant is usable if ANY configured provider is installed and signed in,
    // even when the (Codex-defaulted) active provider still needs setup. This stops a
    // Claude-only user from being told to install Codex.
    const readyProvider = status?.providers.find(
        provider => provider.installState === 'installed' && provider.authState === 'signed-in',
    ) ?? null;
    if (readyProvider && panelView !== 'checking' && panelView !== 'unsupported') {
        const account = (readyProvider.account?.email ?? status?.account?.email)?.trim();
        return {
            tone: 'ready',
            icon: 'i-ph-check-circle',
            label: account
                ? {
                    key: 'settings.assistantPanelStatusReadyAccount',
                    params: { account },
                }
                : { key: 'settings.assistantPanelStatusReady' },
            hint: { key: 'settings.assistantPanelReadyHint' },
            primaryAction: null,
            primaryActionLabelKey: null,
            primaryActionIcon: null,
            showCancelLogin: false,
        };
    }

    if (panelView === 'unsupported') {
        return {
            tone: 'warning',
            icon: 'i-ph-warning-circle',
            label: { key: 'settings.assistantPanelStatusUnsupported' },
            hint: { key: 'settings.assistantPanelUnsupportedHint' },
            primaryAction: null,
            primaryActionLabelKey: null,
            primaryActionIcon: null,
            showCancelLogin: false,
        };
    }

    if (panelView === 'install') {
        return {
            tone: 'warning',
            icon: 'i-ph-download-simple',
            label: { key: 'settings.assistantPanelStatusNeedsCodex' },
            hint: { key: 'settings.assistantPanelNeedsCodexHint' },
            primaryAction: 'install',
            primaryActionLabelKey: 'assistant.installCodex',
            primaryActionIcon: 'i-ph-download-simple',
            showCancelLogin: false,
        };
    }

    if (panelView === 'update') {
        return {
            tone: 'warning',
            icon: 'i-ph-warning-circle',
            label: { key: 'settings.assistantPanelStatusNeedsUpdate' },
            hint: {
                key: 'settings.assistantPanelNeedsUpdateHint',
                params: { version: status?.minimumCodexVersion ?? '' },
            },
            primaryAction: 'update',
            primaryActionLabelKey: 'assistant.updateCodex',
            primaryActionIcon: 'i-ph-arrow-square-out',
            showCancelLogin: false,
        };
    }

    if (panelView === 'sign-in') {
        const isLoginPending = status?.authState === 'login-pending';
        return {
            tone: 'warning',
            icon: isLoginPending ? 'i-ph-arrows-clockwise' : 'i-ph-chat-circle-dots',
            label: { key: isLoginPending ? 'settings.assistantPanelStatusLoginPending' : 'settings.assistantPanelStatusSignedOut' },
            hint: { key: isLoginPending ? 'assistant.loginPending' : 'settings.assistantPanelSignedOutHint' },
            primaryAction: isLoginPending ? null : 'sign-in',
            primaryActionLabelKey: isLoginPending ? null : 'assistant.signInChatGpt',
            primaryActionIcon: isLoginPending ? null : 'i-ph-arrow-square-out',
            showCancelLogin: isLoginPending,
        };
    }

    if (panelView === 'ready') {
        const account = status?.account?.email?.trim();
        return {
            tone: 'ready',
            icon: 'i-ph-check-circle',
            label: account
                ? {
                    key: 'settings.assistantPanelStatusReadyAccount',
                    params: { account },
                }
                : { key: 'settings.assistantPanelStatusReady' },
            hint: { key: 'settings.assistantPanelReadyHint' },
            primaryAction: null,
            primaryActionLabelKey: null,
            primaryActionIcon: null,
            showCancelLogin: false,
        };
    }

    return {
        tone: 'neutral',
        icon: 'i-ph-arrows-clockwise',
        label: { key: 'settings.assistantPanelStatusChecking' },
        hint: { key: 'settings.assistantPanelCheckingHint' },
        primaryAction: null,
        primaryActionLabelKey: null,
        primaryActionIcon: null,
        showCancelLogin: false,
    };
}
