import {
    BrowserWindow,
    app,
} from 'electron';
import {
    createServer,
    type Server,
} from 'http';
import type { AddressInfo } from 'net';
import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
    dirname,
    join,
} from 'node:path';
import type {
    IAgentTabSnapshot,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import type {
    ILocalMcpServerDescriptor,
    ILocalMcpServerIdentity,
    IProcessMcpRequestOptions,
} from '@electron/features/agent/mcp/mcpServerCore';
import {
    getRegisteredMainWindow,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import {
    requestAgentCommand,
    requestAgentWorkspaceSnapshot,
} from '@electron/features/agent/workspaceBridge';
import {
    assertAssistantMcpSnapshotMatchesScope,
    clearAssistantMcpSessionScope,
    createAssistantCommandExecutionScope,
    resolveAssistantMcpSessionScope,
} from '@electron/features/agent/assistantMcpSessionScope';
import {
    inspectAgentDocumentText,
    readAgentDocumentPages,
    searchAgentDocument,
} from '@electron/features/agent/documentText';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { createHttpHandler } from '@electron/features/agent/mcp/createHttpHandler';
import {
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
} from '@electron/features/agent/codexAssistantConfig';

export { processMcpRequest } from '@electron/features/agent/mcp/mcpServerCore';

const logger = createLogger('agent-mcp');
const DEFAULT_MCP_HOST = '127.0.0.1';
const DEFAULT_PROD_MCP_PORT = 38671;
const DEFAULT_DEV_MCP_PORT = 38672;
const LOCAL_MCP_TOKEN_FILE_NAME = 'agent-mcp-token.txt';
const LOCAL_MCP_PROXY_SCRIPT_PATH = join('scripts', 'evb-mcp-proxy.mjs');
const LOCAL_MCP_PROXY_ENV = {
    runAsNode: 'ELECTRON_RUN_AS_NODE',
    url: 'EVB_MCP_URL',
    token: 'EVB_MCP_TOKEN',
} as const;

let localMcpServer: Server | null = null;
let localMcpToken: string | null = null;
let localMcpTokenEnvOwned = false;
let localMcpStartPromise: Promise<void> | null = null;
let embeddedMcpServer: Server | null = null;
let embeddedMcpServerDescriptor: ILocalMcpServerDescriptor | null = null;
// Stable for the server's lifetime so sessions opened earlier keep working; rotated only on full shutdown.
let embeddedMcpToken: string | null = null;
let embeddedMcpStartPromise: Promise<IEmbeddedMcpServerHandle> | null = null;

function getDefaultAgentWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && getWindowByIdFromRegistry(focusedWindow.id)) {
        return focusedWindow;
    }
    return getRegisteredMainWindow();
}

function resolveAgentWindow(windowId?: number) {
    return windowId === undefined
        ? getDefaultAgentWindow()
        : getWindowByIdFromRegistry(windowId);
}

function parsePort(value: string | undefined, fallbackPort: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        return fallbackPort;
    }
    return parsed;
}

export function resolveDefaultLocalMcpPort(isPackaged: boolean) {
    return isPackaged ? DEFAULT_PROD_MCP_PORT : DEFAULT_DEV_MCP_PORT;
}

function getAppUserDataPath() {
    try {
        return app.getPath('userData');
    } catch {
        return null;
    }
}

export function createLocalMcpServerIdentity(port: number, host = DEFAULT_MCP_HOST): ILocalMcpServerIdentity {
    const isPackaged = app.isPackaged;
    const appName = app.getName();
    return {
        name: isPackaged ? 'evb_viewer' : 'evb_viewer_dev',
        title: appName,
        appName,
        version: app.getVersion(),
        isPackaged,
        userDataPath: getAppUserDataPath(),
        host,
        port,
    };
}

function resolveConfiguredLocalMcpPort() {
    return parsePort(process.env.EVB_MCP_PORT, resolveDefaultLocalMcpPort(app.isPackaged));
}

export function getLocalMcpServerDescriptor(): ILocalMcpServerDescriptor {
    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    return {
        name: identity.name,
        title: identity.title,
        host: identity.host,
        port: identity.port,
        url: `http://${identity.host}:${identity.port}`,
    };
}

function getLocalMcpTokenStoragePath() {
    return join(app.getPath('userData'), LOCAL_MCP_TOKEN_FILE_NAME);
}

async function readPersistedLocalMcpToken() {
    try {
        const token = (await readFile(getLocalMcpTokenStoragePath(), 'utf8')).trim();
        return token.length > 0 ? token : null;
    } catch {
        return null;
    }
}

async function persistLocalMcpToken(token: string) {
    const tokenPath = getLocalMcpTokenStoragePath();
    await mkdir(dirname(tokenPath), {recursive: true});
    await writeFile(tokenPath, `${token}\n`, 'utf8');
}

async function ensureLocalMcpServerBearerToken() {
    const configuredToken = process.env[ASSISTANT_MCP_TOKEN_ENV]?.trim();
    if (!localMcpToken) {
        if (configuredToken && configuredToken.length > 0) {
            localMcpToken = configuredToken;
        } else {
            localMcpToken = await readPersistedLocalMcpToken()
                ?? randomBytes(32).toString('hex');
            await persistLocalMcpToken(localMcpToken);
            localMcpTokenEnvOwned = true;
        }
    }
    process.env[ASSISTANT_MCP_TOKEN_ENV] = localMcpToken;
    return localMcpToken;
}

interface ILocalMcpProxyLaunchConfig {
    command: string;
    args: string[];
    env: Record<string, string>;
}

function getAppRootPath() {
    try {
        return app.getAppPath();
    } catch {
        return process.cwd();
    }
}

function resolveLocalMcpProxyScriptPath() {
    return join(getAppRootPath(), LOCAL_MCP_PROXY_SCRIPT_PATH);
}

function createLocalMcpProxyLaunchConfig(
    descriptor: ILocalMcpServerDescriptor,
    token: string,
): ILocalMcpProxyLaunchConfig {
    return {
        command: process.execPath,
        args: [resolveLocalMcpProxyScriptPath()],
        env: {
            [LOCAL_MCP_PROXY_ENV.runAsNode]: '1',
            [LOCAL_MCP_PROXY_ENV.url]: descriptor.url,
            [LOCAL_MCP_PROXY_ENV.token]: token,
        },
    };
}

function shellQuote(value: string) {
    if (process.platform === 'win32') {
        return `"${value.replace(/"/gu, '\\"')}"`;
    }
    return `'${value.replace(/'/gu, '\'\\\'\'')}'`;
}

function createCodexSetupSnippet(
    descriptor: ILocalMcpServerDescriptor,
    launchConfig: ILocalMcpProxyLaunchConfig,
) {
    return [
        'codex',
        'mcp',
        'add',
        shellQuote(descriptor.name),
        '--env',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.runAsNode}=1`),
        '--env',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.url}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.url]}`),
        '--env',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.token}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.token]}`),
        '--',
        shellQuote(launchConfig.command),
        ...launchConfig.args.map(shellQuote),
    ].join(' ');
}

function createClaudeSetupSnippet(
    descriptor: ILocalMcpServerDescriptor,
    launchConfig: ILocalMcpProxyLaunchConfig,
) {
    return [
        'claude',
        'mcp',
        'add',
        '--scope',
        'user',
        shellQuote(descriptor.name),
        '-e',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.runAsNode}=1`),
        '-e',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.url}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.url]}`),
        '-e',
        shellQuote(`${LOCAL_MCP_PROXY_ENV.token}=${launchConfig.env[LOCAL_MCP_PROXY_ENV.token]}`),
        '--',
        shellQuote(launchConfig.command),
        ...launchConfig.args.map(shellQuote),
    ].join(' ');
}

export async function getLocalMcpSetupSnippets() {
    const descriptor = getLocalMcpServerDescriptor();
    const token = await ensureLocalMcpServerBearerToken();
    const launchConfig = createLocalMcpProxyLaunchConfig(descriptor, token);
    return {
        codex: createCodexSetupSnippet(descriptor, launchConfig),
        claude: createClaudeSetupSnippet(descriptor, launchConfig),
        cursor: JSON.stringify({mcpServers: { [descriptor.name]: {
            command: launchConfig.command,
            args: launchConfig.args,
            env: launchConfig.env,
        } }}, null, 2),
    };
}

export async function getLocalMcpCodexRegistrationTransport() {
    const descriptor = getLocalMcpServerDescriptor();
    const token = await ensureLocalMcpServerBearerToken();
    return {
        descriptor,
        launchConfig: createLocalMcpProxyLaunchConfig(descriptor, token),
        token,
    };
}

function clearGeneratedLocalMcpTokenEnv() {
    if (localMcpTokenEnvOwned && process.env[ASSISTANT_MCP_TOKEN_ENV] === localMcpToken) {
        Reflect.deleteProperty(process.env, ASSISTANT_MCP_TOKEN_ENV);
    }
    localMcpTokenEnvOwned = false;
}

export function isLocalMcpServerRunning() {
    return localMcpServer !== null;
}

function resolveInternalAssistantWindow(windowId?: number) {
    const binding = resolveAssistantMcpSessionScope(windowId);
    const window = getWindowByIdFromRegistry(binding.windowId);
    if (!window) {
        throw new Error('No live renderer window is available for the active assistant MCP turn.');
    }
    return {
        binding,
        window,
    };
}

function assertInternalInputTabMatchesBinding(
    tab: IAgentTabSnapshot,
    binding: ReturnType<typeof resolveAssistantMcpSessionScope>,
) {
    if (tab.tabId !== binding.tabId) {
        throw new Error('Internal EVB MCP request targeted a different tab than the active assistant turn.');
    }
    if (
        binding.commandTarget
        && !commandTargetsMatch(binding.commandTarget, tab.commandTarget)
    ) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
    if ((binding.documentInstanceId ?? null) !== (tab.documentInstanceId ?? null)) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
    if (binding.documentIdentity === null) {
        return;
    }
    if (
        tab.documentIdentity?.token !== binding.documentIdentity.token
        || tab.documentIdentity.documentRef !== binding.documentIdentity.documentRef
    ) {
        throw new Error('The active assistant document changed before the internal EVB MCP request completed.');
    }
}

function commandTargetsMatch(
    expected: TAgentWorkspaceCommandTarget,
    actual: TAgentWorkspaceCommandTarget | undefined,
) {
    if (!actual) {
        return false;
    }

    if (
        expected.kind !== actual.kind
        || expected.tabId !== actual.tabId
        || expected.sessionId !== actual.sessionId
        || expected.documentRef !== actual.documentRef
        || expected.documentBackend !== actual.documentBackend
        || (expected.documentInstanceId ?? null) !== (actual.documentInstanceId ?? null)
        || expected.documentRevisionToken !== actual.documentRevisionToken
    ) {
        return false;
    }

    return expected.kind === 'transaction'
        ? actual.kind === 'transaction' && expected.transactionId === actual.transactionId
        : actual.kind === 'revision' && expected.sessionRevision === actual.sessionRevision;
}

function createDefaultMcpRequestOptions(
    identity: ILocalMcpServerIdentity,
    callerKind: 'external' | 'internal',
): IProcessMcpRequestOptions {
    if (callerKind === 'internal') {
        return {
            identity,
            callerKind,
            getWorkspaceSnapshot: async (windowId) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId);
                const snapshot = await requestAgentWorkspaceSnapshot(
                    window,
                    undefined,
                    createAssistantCommandExecutionScope(binding),
                );
                assertAssistantMcpSnapshotMatchesScope(snapshot, binding);
                return snapshot;
            },
            runCommand: async (command, windowId, signal) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId);
                const scope = createAssistantCommandExecutionScope(binding);
                const snapshot = await requestAgentWorkspaceSnapshot(window, undefined, scope);
                assertAssistantMcpSnapshotMatchesScope(snapshot, binding);
                return requestAgentCommand(
                    window,
                    command,
                    undefined,
                    scope,
                    signal,
                );
            },
            inspectDocumentText: async (input, windowId) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId);
                if (!window) {
                    throw new Error('No live renderer window is available for document text inspection.');
                }
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return inspectAgentDocumentText(window, input);
            },
            searchDocument: async (input, windowId) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId);
                if (!window) {
                    throw new Error('No live renderer window is available for document search.');
                }
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return searchAgentDocument(window, input);
            },
            readDocumentPages: async (input, windowId) => {
                const {
                    binding,
                    window,
                } = resolveInternalAssistantWindow(windowId);
                if (!window) {
                    throw new Error('No live renderer window is available for document page text reading.');
                }
                assertInternalInputTabMatchesBinding(input.tab, binding);
                return readAgentDocumentPages(window, input);
            },
        };
    }

    return {
        identity,
        callerKind,
        getWorkspaceSnapshot: async (windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentWorkspaceSnapshot(window);
        },
        runCommand: async (command, windowId, signal) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentCommand(window, command, undefined, undefined, signal);
        },
        inspectDocumentText: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document text inspection.');
            }
            return inspectAgentDocumentText(window, input);
        },
        searchDocument: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document search.');
            }
            return searchAgentDocument(window, input);
        },
        readDocumentPages: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document page text reading.');
            }
            return readAgentDocumentPages(window, input);
        },
    };
}

export function startLocalMcpServer() {
    if (localMcpStartPromise) {
        return localMcpStartPromise;
    }
    if (localMcpServer) {
        return Promise.resolve();
    }
    const startPromise = (async () => {
        const bearerToken = await ensureLocalMcpServerBearerToken();
        const port = resolveConfiguredLocalMcpPort();
        const identity = createLocalMcpServerIdentity(port);
        const options = {...createDefaultMcpRequestOptions(identity, 'external')};

        const server = createServer(createHttpHandler(options, { bearerToken }));
        localMcpServer = server;
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const failStartup = (error: Error) => {
                logger.error(`Local MCP server failed: ${getErrorMessage(error)}`);
                if (settled) {
                    return;
                }
                settled = true;
                if (localMcpServer === server) {
                    localMcpServer = null;
                }
                reject(error);
            };

            server.on('error', error => failStartup(error instanceof Error ? error : new Error(getErrorMessage(error))));
            server.on('close', () => {
                failStartup(new Error('Local MCP server was shut down during startup.'));
            });
            server.listen(port, DEFAULT_MCP_HOST, () => {
                if (settled) {
                    return;
                }
                if (localMcpServer !== server) {
                    server.close();
                    failStartup(new Error('Local MCP server was shut down during startup.'));
                    return;
                }

                settled = true;
                const address = server.address() as AddressInfo | null;
                logger.info(`Local MCP server ${identity.name} listening on http://${DEFAULT_MCP_HOST}:${address?.port ?? port}`);
                resolve();
            });
        });
    })().finally(() => {
        if (localMcpStartPromise === startPromise) {
            localMcpStartPromise = null;
        }
    });
    localMcpStartPromise = startPromise;
    return startPromise;
}

export function shutdownLocalMcpServer() {
    const server = localMcpServer;
    if (!server) {
        clearGeneratedLocalMcpTokenEnv();
        localMcpToken = null;
        return Promise.resolve();
    }

    localMcpServer = null;
    localMcpStartPromise = null;
    return new Promise<void>((resolve) => {
        server.close(() => {
            clearGeneratedLocalMcpTokenEnv();
            localMcpToken = null;
            resolve();
        });
    });
}

export function isEmbeddedMcpServerRunning() {
    return embeddedMcpServer !== null;
}

export function getEmbeddedMcpServerDescriptor() {
    return embeddedMcpServerDescriptor;
}

export interface IEmbeddedMcpServerHandle {
    descriptor: ILocalMcpServerDescriptor;
    token: string;
}

export function startEmbeddedMcpServer(): Promise<IEmbeddedMcpServerHandle> {
    if (embeddedMcpServer && embeddedMcpServerDescriptor && embeddedMcpToken) {
        if (embeddedMcpServerDescriptor.name !== ASSISTANT_MCP_SERVER_NAME) {
            return shutdownEmbeddedMcpServer().then(() => startEmbeddedMcpServer());
        }
        return Promise.resolve({
            descriptor: embeddedMcpServerDescriptor,
            token: embeddedMcpToken,
        });
    }
    if (embeddedMcpStartPromise) {
        return embeddedMcpStartPromise;
    }

    const token = embeddedMcpToken ?? randomBytes(32).toString('hex');
    embeddedMcpToken = token;

    const startPromise = new Promise<IEmbeddedMcpServerHandle>((resolve, reject) => {
        const identity = createLocalMcpServerIdentity(0);
        identity.name = ASSISTANT_MCP_SERVER_NAME;
        identity.title = `${identity.title} Assistant`;
        const options = createDefaultMcpRequestOptions(identity, 'internal');
        const server = createServer(createHttpHandler(options, { bearerToken: token }));
        // Track the binding server immediately so a shutdown racing the bind can always close it.
        embeddedMcpServer = server;
        let settled = false;

        const failStartup = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (embeddedMcpServer === server) {
                embeddedMcpServer = null;
                embeddedMcpServerDescriptor = null;
            }
            reject(error);
        };

        server.on('error', (error) => {
            logger.error(`Embedded MCP server failed: ${getErrorMessage(error)}`);
            failStartup(error instanceof Error ? error : new Error(getErrorMessage(error)));
        });
        // If a shutdown closes the server mid-bind, Node aborts the bind and fires neither the
        // listen callback nor 'error' — only 'close'. Settle here so awaiters don't hang forever.
        server.on('close', () => {
            failStartup(new Error('Embedded MCP server was shut down during startup.'));
        });
        server.listen(0, DEFAULT_MCP_HOST, () => {
            if (settled) {
                return;
            }
            // A shutdown that raced this bind has already detached the server.
            if (embeddedMcpServer !== server) {
                server.close();
                failStartup(new Error('Embedded MCP server was shut down during startup.'));
                return;
            }

            const address = server.address() as AddressInfo | null;
            const port = address?.port;
            if (!port) {
                server.close();
                failStartup(new Error('Embedded MCP server did not receive a port.'));
                return;
            }

            identity.port = port;
            embeddedMcpServerDescriptor = {
                name: identity.name,
                title: identity.title,
                host: identity.host,
                port,
                url: `http://${identity.host}:${port}`,
            };
            settled = true;
            logger.info(`Embedded MCP server ${identity.name} listening on ${embeddedMcpServerDescriptor.url}`);
            resolve({
                descriptor: embeddedMcpServerDescriptor,
                token,
            });
        });
    }).finally(() => {
        if (embeddedMcpStartPromise === startPromise) {
            embeddedMcpStartPromise = null;
        }
    });

    embeddedMcpStartPromise = startPromise;
    return startPromise;
}

export function shutdownEmbeddedMcpServer() {
    clearAssistantMcpSessionScope();
    const server = embeddedMcpServer;
    embeddedMcpServer = null;
    embeddedMcpServerDescriptor = null;
    embeddedMcpToken = null;
    embeddedMcpStartPromise = null;
    if (!server) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}
