import {
    BrowserWindow,
    app,
} from 'electron';
import {
    createServer,
    type Server,
} from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
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

function getLocalMcpServerBearerToken() {
    const configuredToken = process.env[ASSISTANT_MCP_TOKEN_ENV]?.trim();
    if (!localMcpToken) {
        if (configuredToken && configuredToken.length > 0) {
            localMcpToken = configuredToken;
        } else {
            localMcpToken = randomBytes(32).toString('hex');
            localMcpTokenEnvOwned = true;
        }
    }
    process.env[ASSISTANT_MCP_TOKEN_ENV] = localMcpToken;
    return localMcpToken;
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

function createDefaultMcpRequestOptions(identity: ILocalMcpServerIdentity): IProcessMcpRequestOptions {
    return {
        identity,
        getWorkspaceSnapshot: async (windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentWorkspaceSnapshot(window);
        },
        runCommand: async (command, windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentCommand(window, command);
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
    const bearerToken = getLocalMcpServerBearerToken();
    if (localMcpStartPromise) {
        return localMcpStartPromise;
    }
    if (localMcpServer) {
        return Promise.resolve();
    }

    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    const options = {
        ...createDefaultMcpRequestOptions(identity),
        callerKind: 'external' as const,
    };

    const server = createServer(createHttpHandler(options, { bearerToken }));
    localMcpServer = server;
    const startPromise = new Promise<void>((resolve, reject) => {
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
    }).finally(() => {
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
        const options = {
            ...createDefaultMcpRequestOptions(identity),
            callerKind: 'internal' as const,
        };
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
