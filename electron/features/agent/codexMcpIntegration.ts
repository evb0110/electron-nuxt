import {
    dialog,
    shell,
} from 'electron';
import type {
    BrowserWindow,
    MessageBoxOptions,
} from 'electron';
import type {
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    TAgentMcpCodexRegistrationState,
} from '@contracts/agent';
import {
    getLocalMcpServerDescriptor,
    isLocalMcpServerRunning,
    shutdownLocalMcpServer,
    startLocalMcpServer,
} from '@electron/features/agent/mcpServer';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import {
    CODEX_APP_INSTALL_URL,
    resolveCodexCliPath,
    runCodexCli,
} from '@electron/features/agent/codexCli';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-mcp');

interface ICodexServerConfig {
    enabled?: unknown;
    transport?: {
        type?: unknown;
        url?: unknown;
    };
}

function createBaseStatus(): Omit<IAgentMcpIntegrationStatus, 'enabled'> {
    const descriptor = getLocalMcpServerDescriptor();
    return {
        serverName: descriptor.name,
        serverUrl: descriptor.url,
        serverRunning: isLocalMcpServerRunning(),
        codexInstalled: false,
        codexPath: null,
        codexConfigured: false,
        codexRegistrationState: 'unknown',
        installUrl: CODEX_APP_INSTALL_URL,
        lastCheckedAt: new Date().toISOString(),
    };
}

function createStatus(
    enabled: boolean,
    patch: Partial<Omit<IAgentMcpIntegrationStatus, 'enabled'>> = {},
): IAgentMcpIntegrationStatus {
    return {
        enabled,
        ...createBaseStatus(),
        ...patch,
    };
}

function parseCodexServerConfig(stdout: string): ICodexServerConfig | null {
    try {
        const parsed: unknown = JSON.parse(stdout);
        return parsed && typeof parsed === 'object'
            ? parsed
            : null;
    } catch {
        return null;
    }
}

async function getCodexRegistrationState(codexPath: string) {
    const descriptor = getLocalMcpServerDescriptor();
    const result = await runCodexCli(codexPath, [
        'mcp',
        'get',
        descriptor.name,
        '--json',
    ]);
    if (!result.ok) {
        return {
            state: 'missing' as TAgentMcpCodexRegistrationState,
            configured: false,
        };
    }

    const config = parseCodexServerConfig(result.stdout);
    const configured = config?.enabled === true
        && config.transport?.type === 'streamable_http'
        && config.transport.url === descriptor.url;
    return {
        state: configured
            ? 'configured' as const
            : 'mismatched' as const,
        configured,
    };
}

async function removeCodexRegistration(codexPath: string) {
    await runCodexCli(codexPath, [
        'mcp',
        'remove',
        getLocalMcpServerDescriptor().name,
    ]);
}

async function registerCodexMcp(codexPath: string) {
    const descriptor = getLocalMcpServerDescriptor();
    await removeCodexRegistration(codexPath);
    const result = await runCodexCli(codexPath, [
        'mcp',
        'add',
        descriptor.name,
        '--url',
        descriptor.url,
    ]);
    if (!result.ok) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'Codex MCP registration failed.');
    }
}

async function showInstallCodexDialog(parentWindow?: BrowserWindow | null) {
    const openInstall = te('dialogs.agentMcp.openInstall');
    const cancel = te('dialogs.agentMcp.cancel');
    const options = {
        type: 'info',
        title: te('dialogs.agentMcp.codexMissingTitle'),
        message: te('dialogs.agentMcp.codexMissingMessage'),
        detail: te('dialogs.agentMcp.codexMissingDetail'),
        buttons: [
            openInstall,
            cancel,
        ],
        defaultId: 0,
        cancelId: 1,
    } satisfies MessageBoxOptions;
    const { response } = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    if (response === 0) {
        await shell.openExternal(CODEX_APP_INSTALL_URL);
    }
}

async function confirmCodexMutation(parentWindow: BrowserWindow | null | undefined, enabled: boolean) {
    const descriptor = getLocalMcpServerDescriptor();
    const allowLabel = enabled
        ? te('dialogs.agentMcp.enableAllow')
        : te('dialogs.agentMcp.disableAllow');
    const cancelLabel = te('dialogs.agentMcp.cancel');
    const options = {
        type: 'question',
        title: enabled
            ? te('dialogs.agentMcp.enableTitle')
            : te('dialogs.agentMcp.disableTitle'),
        message: enabled
            ? te('dialogs.agentMcp.enableMessage')
            : te('dialogs.agentMcp.disableMessage'),
        detail: te('dialogs.agentMcp.configDetail', {
            server: descriptor.name,
            url: descriptor.url,
        }),
        buttons: [
            allowLabel,
            cancelLabel,
        ],
        defaultId: 0,
        cancelId: 1,
    } satisfies MessageBoxOptions;
    const { response } = parentWindow
        ? await dialog.showMessageBox(parentWindow, options)
        : await dialog.showMessageBox(options);
    return response === 0;
}

export async function getAgentMcpIntegrationStatus(): Promise<IAgentMcpIntegrationStatus> {
    const settings = await loadSettings();
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        return createStatus(settings.agentMcpEnabled, {codexRegistrationState: 'unknown'});
    }

    try {
        const registration = await getCodexRegistrationState(codexPath);
        return createStatus(settings.agentMcpEnabled, {
            codexInstalled: true,
            codexPath,
            codexConfigured: registration.configured,
            codexRegistrationState: registration.state,
        });
    } catch (error) {
        return createStatus(settings.agentMcpEnabled, {
            codexInstalled: true,
            codexPath,
            codexRegistrationState: 'unknown',
            error: getErrorMessage(error),
        });
    }
}

async function setAgentMcpSetting(enabled: boolean) {
    await updateSettings(settings => {
        settings.agentMcpEnabled = enabled;
    });
}

export async function setAgentMcpIntegrationEnabled(
    enabled: boolean,
    parentWindow?: BrowserWindow | null,
): Promise<IAgentMcpIntegrationUpdateResult> {
    const previousSettings = await loadSettings();
    const codexPath = await resolveCodexCliPath();
    if (!codexPath) {
        if (!enabled) {
            await shutdownLocalMcpServer();
            await setAgentMcpSetting(false);
            return {
                ok: true,
                status: await getAgentMcpIntegrationStatus(),
            };
        }
        await showInstallCodexDialog(parentWindow);
        const status = await getAgentMcpIntegrationStatus();
        return {
            ok: false,
            status,
            error: te('dialogs.agentMcp.codexMissingTitle'),
        };
    }

    const confirmed = await confirmCodexMutation(parentWindow, enabled);
    if (!confirmed) {
        return {
            ok: false,
            cancelled: true,
            status: await getAgentMcpIntegrationStatus(),
        };
    }

    try {
        if (enabled) {
            startLocalMcpServer();
            await registerCodexMcp(codexPath);
            await setAgentMcpSetting(true);
        } else {
            await removeCodexRegistration(codexPath);
            await shutdownLocalMcpServer();
            await setAgentMcpSetting(false);
        }
        return {
            ok: true,
            status: await getAgentMcpIntegrationStatus(),
        };
    } catch (error) {
        logger.error(`Failed to ${enabled ? 'enable' : 'disable'} Codex MCP integration: ${getErrorMessage(error)}`);
        if (enabled && !previousSettings.agentMcpEnabled) {
            await shutdownLocalMcpServer();
        }
        return {
            ok: false,
            status: await getAgentMcpIntegrationStatus(),
            error: getErrorMessage(error),
        };
    }
}

export async function syncAgentMcpServerWithSettings() {
    const settings = await loadSettings();
    if (settings.agentMcpEnabled) {
        startLocalMcpServer();
    } else {
        await shutdownLocalMcpServer();
    }
}
