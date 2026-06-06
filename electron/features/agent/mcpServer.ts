import {
    BrowserWindow,
    app,
} from 'electron';
import {
    createServer,
    type Server,
} from 'http';
import type { AddressInfo } from 'net';
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

export { processMcpRequest } from '@electron/features/agent/mcp/mcpServerCore';

const logger = createLogger('agent-mcp');
const DEFAULT_MCP_HOST = '127.0.0.1';
const DEFAULT_PROD_MCP_PORT = 38671;
const DEFAULT_DEV_MCP_PORT = 38672;

let localMcpServer: Server | null = null;
let embeddedMcpServer: Server | null = null;
let embeddedMcpServerDescriptor: ILocalMcpServerDescriptor | null = null;

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
    if (localMcpServer) {
        return;
    }

    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    const options = createDefaultMcpRequestOptions(identity);

    const server = createServer(createHttpHandler(options));
    server.on('error', (error) => {
        logger.error(`Local MCP server failed: ${getErrorMessage(error)}`);
    });
    server.listen(port, DEFAULT_MCP_HOST, () => {
        const address = server.address() as AddressInfo | null;
        logger.info(`Local MCP server ${identity.name} listening on http://${DEFAULT_MCP_HOST}:${address?.port ?? port}`);
    });
    localMcpServer = server;
}

export function shutdownLocalMcpServer() {
    const server = localMcpServer;
    if (!server) {
        return Promise.resolve();
    }

    localMcpServer = null;
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

export function isEmbeddedMcpServerRunning() {
    return embeddedMcpServer !== null;
}

export function getEmbeddedMcpServerDescriptor() {
    return embeddedMcpServerDescriptor;
}

export function startEmbeddedMcpServer(bearerToken: string): Promise<ILocalMcpServerDescriptor> {
    if (embeddedMcpServer && embeddedMcpServerDescriptor) {
        return Promise.resolve(embeddedMcpServerDescriptor);
    }

    return new Promise((resolve, reject) => {
        const identity = createLocalMcpServerIdentity(0);
        identity.name = `${identity.name}_embedded`;
        identity.title = `${identity.title} Assistant`;
        const options = createDefaultMcpRequestOptions(identity);
        const server = createServer(createHttpHandler(options, { bearerToken }));
        let settled = false;

        server.on('error', (error) => {
            logger.error(`Embedded MCP server failed: ${getErrorMessage(error)}`);
            if (!settled) {
                settled = true;
                embeddedMcpServer = null;
                embeddedMcpServerDescriptor = null;
                reject(error);
            }
        });
        server.listen(0, DEFAULT_MCP_HOST, () => {
            const address = server.address() as AddressInfo | null;
            const port = address?.port;
            if (!port) {
                embeddedMcpServer = null;
                embeddedMcpServerDescriptor = null;
                settled = true;
                server.close();
                reject(new Error('Embedded MCP server did not receive a port.'));
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
            embeddedMcpServer = server;
            settled = true;
            logger.info(`Embedded MCP server ${identity.name} listening on ${embeddedMcpServerDescriptor.url}`);
            resolve(embeddedMcpServerDescriptor);
        });
    });
}

export function shutdownEmbeddedMcpServer() {
    const server = embeddedMcpServer;
    if (!server) {
        embeddedMcpServerDescriptor = null;
        return Promise.resolve();
    }

    embeddedMcpServer = null;
    embeddedMcpServerDescriptor = null;
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}
