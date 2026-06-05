import type {
    ILocalMcpServerDescriptor as ICoreLocalMcpServerDescriptor,
    ILocalMcpServerIdentity as ICoreLocalMcpServerIdentity,
} from '@electron/features/agent/mcp/mcpServerCore';
import {
    createLocalMcpServerIdentity as createLocalMcpServerIdentityImpl,
    getEmbeddedMcpServerDescriptor as getEmbeddedMcpServerDescriptorImpl,
    getLocalMcpServerDescriptor as getLocalMcpServerDescriptorImpl,
    isEmbeddedMcpServerRunning as isEmbeddedMcpServerRunningImpl,
    isLocalMcpServerRunning as isLocalMcpServerRunningImpl,
    resolveDefaultLocalMcpPort as resolveDefaultLocalMcpPortImpl,
    shutdownEmbeddedMcpServer as shutdownEmbeddedMcpServerImpl,
    shutdownLocalMcpServer as shutdownLocalMcpServerImpl,
    startEmbeddedMcpServer as startEmbeddedMcpServerImpl,
    startLocalMcpServer as startLocalMcpServerImpl,
} from '@electron/features/agent/mcp/mcpServerLifecycle';

export { processMcpRequest } from '@electron/features/agent/mcp/mcpServerCore';

export interface ILocalMcpServerIdentity extends ICoreLocalMcpServerIdentity {}
export interface ILocalMcpServerDescriptor extends ICoreLocalMcpServerDescriptor {}

export function resolveDefaultLocalMcpPort(isPackaged: boolean) {
    return resolveDefaultLocalMcpPortImpl(isPackaged);
}

export function createLocalMcpServerIdentity(
    port: number,
    host?: string,
): ILocalMcpServerIdentity {
    return createLocalMcpServerIdentityImpl(port, host);
}

export function getLocalMcpServerDescriptor(): ILocalMcpServerDescriptor {
    return getLocalMcpServerDescriptorImpl();
}

export function isLocalMcpServerRunning() {
    return isLocalMcpServerRunningImpl();
}

export function startLocalMcpServer() {
    return startLocalMcpServerImpl();
}

export function shutdownLocalMcpServer() {
    return shutdownLocalMcpServerImpl();
}

export function isEmbeddedMcpServerRunning() {
    return isEmbeddedMcpServerRunningImpl();
}

export function getEmbeddedMcpServerDescriptor(): ILocalMcpServerDescriptor | null {
    return getEmbeddedMcpServerDescriptorImpl();
}

export function startEmbeddedMcpServer(
    bearerToken: string,
): Promise<ILocalMcpServerDescriptor> {
    return startEmbeddedMcpServerImpl(bearerToken);
}

export function shutdownEmbeddedMcpServer() {
    return shutdownEmbeddedMcpServerImpl();
}
