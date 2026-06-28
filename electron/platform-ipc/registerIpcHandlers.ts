import { ipcMain } from 'electron';
import {
    registerCoreIpcHandlers,
    type ICoreIpcHandlerOptions,
} from '@electron/platform-ipc/coreIpcHandlers';
import { createAgentService } from '@electron/features/agent/createAgentService';
import { registerFeatureIpcAdapters } from '@electron/platform-ipc/featureIpcAdapters';

export { normalizeRendererLogEntry } from '@electron/platform-ipc/rendererLogBridge';

export function registerIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    const agentService = createAgentService();
    registerCoreIpcHandlers(ipcMain, options, {agentService});
    registerFeatureIpcAdapters(ipcMain, {agentService});
}
