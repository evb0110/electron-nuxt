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
    getLocalMcpCodexRegistrationTransport,
    getLocalMcpServerDescriptor,
    getLocalMcpSetupSnippets,
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
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-mcp');

interface ICodexServerConfig {
    enabled?: unknown;
    transport?: {
        type?: unknown;
        url?: unknown;
        command?: unknown;
        args?: unknown;
        env?: unknown;
    };
}

function getTransportEnv(config: ICodexServerConfig | null) {
    const env = config?.transport?.env;
    return typeof env === 'object' && env !== null && !Array.isArray(env)
        ? env as Record<string, unknown>
        : null;
}

async function createBaseStatus(): Promise<Omit<IAgentMcpIntegrationStatus, 'enabled'>> {
    const descriptor = getLocalMcpServerDescriptor();
    const setupSnippets = await getLocalMcpSetupSnippets();
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
        setupSnippets,
    };
}

async function createStatus(
    enabled: boolean,
    patch: Partial<Omit<IAgentMcpIntegrationStatus, 'enabled'>> = {},
): Promise<IAgentMcpIntegrationStatus> {
    return {
        enabled,
        ...await createBaseStatus(),
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
    const {
        launchConfig,
        token,
    } = await getLocalMcpCodexRegistrationTransport();
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
    const transportEnv = getTransportEnv(config);
    const configured = config?.enabled === true
        && config.transport?.type === 'stdio'
        && config.transport.command === launchConfig.command
        && Array.isArray(config.transport.args)
        && config.transport.args.length === launchConfig.args.length
        && config.transport.args.every((arg, index) => arg === launchConfig.args[index])
        && transportEnv !== null
        && transportEnv.ELECTRON_RUN_AS_NODE === '1'
        && transportEnv.EVB_MCP_URL === descriptor.url
        && transportEnv.EVB_MCP_TOKEN === token;
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
    const {
        descriptor,
        launchConfig,
    } = await getLocalMcpCodexRegistrationTransport();
    await removeCodexRegistration(codexPath);
    const result = await runCodexCli(codexPath, [
        'mcp',
        'add',
        descriptor.name,
        '--env',
        'ELECTRON_RUN_AS_NODE=1',
        '--env',
        `EVB_MCP_URL=${launchConfig.env.EVB_MCP_URL}`,
        '--env',
        `EVB_MCP_TOKEN=${launchConfig.env.EVB_MCP_TOKEN}`,
        '--',
        launchConfig.command,
        ...launchConfig.args,
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
        return await createStatus(settings.agentMcpEnabled, {
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
        return undefined;
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
            await startLocalMcpServer();
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
        await startLocalMcpServer();
    } else {
        await shutdownLocalMcpServer();
    }
}
