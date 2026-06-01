import {
    constants,
    existsSync,
} from 'fs';
import { access } from 'fs/promises';
import {
    delimiter,
    join,
} from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
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
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-codex-mcp');
const CODEX_INSTALL_URL = 'https://developers.openai.com/codex/app';
const CODEX_COMMAND_TIMEOUT_MS = 15_000;
const SHELL_DETECTION_TIMEOUT_MS = 5_000;

interface ICommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

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
        installUrl: CODEX_INSTALL_URL,
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

function uniqueStrings(values: string[]) {
    return [...new Set(values.filter(value => value.trim().length > 0))];
}

function buildCodexPathCandidates() {
    const candidates = [
        process.env.CODEX_CLI_PATH,
        process.platform === 'darwin'
            ? '/Applications/Codex.app/Contents/Resources/codex'
            : undefined,
        ...((process.env.PATH ?? '').split(delimiter).map(pathEntry => join(pathEntry, process.platform === 'win32' ? 'codex.cmd' : 'codex'))),
        join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.cmd' : 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/usr/bin/codex',
    ];
    return uniqueStrings(candidates.filter((candidate): candidate is string => typeof candidate === 'string'));
}

async function isExecutable(path: string) {
    if (!existsSync(path)) {
        return false;
    }

    if (process.platform === 'win32') {
        return true;
    }

    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function runCommand(command: string, args: string[], timeoutMs = CODEX_COMMAND_TIMEOUT_MS): Promise<ICommandResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: {
                ...process.env,
                NO_COLOR: '1',
            },
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            child.kill();
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: stderr || 'Command timed out.',
                exitCode: null,
            });
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', (error) => {
            if (settled) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: false,
                stdout,
                stderr: getErrorMessage(error),
                exitCode: null,
            });
        });
        child.on('close', (exitCode) => {
            if (settled) {
                return;
            }
            clearTimeout(timeout);
            settled = true;
            resolve({
                ok: exitCode === 0,
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}

async function findCodexInLoginShell() {
    if (process.platform === 'win32') {
        return null;
    }

    const shellPath = process.env.SHELL || '/bin/zsh';
    if (!existsSync(shellPath)) {
        return null;
    }

    const result = await runCommand(shellPath, [
        '-lc',
        'command -v codex',
    ], SHELL_DETECTION_TIMEOUT_MS);
    const candidate = result.stdout.trim().split('\n')[0]?.trim();
    if (!candidate || !(await isExecutable(candidate))) {
        return null;
    }
    return candidate;
}

async function resolveCodexCliPath() {
    for (const candidate of buildCodexPathCandidates()) {
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }
    return findCodexInLoginShell();
}

async function runCodex(codexPath: string, args: string[]) {
    return runCommand(codexPath, args);
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
    const result = await runCodex(codexPath, [
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
    await runCodex(codexPath, [
        'mcp',
        'remove',
        getLocalMcpServerDescriptor().name,
    ]);
}

async function registerCodexMcp(codexPath: string) {
    const descriptor = getLocalMcpServerDescriptor();
    await removeCodexRegistration(codexPath);
    const result = await runCodex(codexPath, [
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
        await shell.openExternal(CODEX_INSTALL_URL);
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
