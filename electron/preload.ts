import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from 'electron';
import { installViteOutdatedOptimizeDepRecovery } from '@electron/preload/installViteOutdatedOptimizeDepRecovery';
import { createElectronApi } from '@electron/preload/createElectronApi';
import { markPreloadInstalled } from '@electron/preload/markPreloadInstalled';
import { installDebugLogListener } from '@electron/preload/installDebugLogListener';
import {
    createPreloadMainLogger,
    exposeStartupTraceFlag,
    tracePreload,
    type TPreloadLogLevel,
} from '@electron/preload/preloadLog';
import { installStartupOverlayLifecycle } from '@electron/preload/installStartupOverlayLifecycle';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { createCodecIpcInvoker } from '@electron/preload/ipcClient';
const preloadAlreadyInstalled = markPreloadInstalled();
if (preloadAlreadyInstalled) {
    console.debug('[Preload] Re-exposing bridge for duplicate installation (fast reload detected)');
}

tracePreload('preload installation started');
exposeStartupTraceFlag();
installDebugLogListener(ipcRenderer);

const forwardPreloadLogToMain = createPreloadMainLogger(ipcRenderer);
const logDevRecovery = (level: TPreloadLogLevel, message: string, data?: Record<string, unknown>) => {
    if (level === 'debug') {
        if (data) {
            console.debug(message, data);
        } else {
            console.debug(message);
        }
    } else if (level === 'info') {
        if (data) {
            console.info(message, data);
        } else {
            console.info(message);
        }
    } else if (level === 'warn') {
        if (data) {
            console.warn(message, data);
        } else {
            console.warn(message);
        }
    } else if (data) {
        console.error(message, data);
    } else {
        console.error(message);
    }

    forwardPreloadLogToMain(level, 'devRecovery', message, data);
};

installViteOutdatedOptimizeDepRecovery({ log: logDevRecovery });
tracePreload('dev recovery hooks installed');

function isRendererAutomationFileOpenHelperEnabled() {
    return process.env.EVB_AUTOMATION_USER_DATA_DIR
        && process.env.EVB_AUTOMATION_SESSION_NAME
        && process.env.EVB_ENABLE_RENDERER_FILE_OPEN_HELPER === '1';
}

const deferredAutomationDocumentOpens = new Map<string, {
    promise: Promise<void>;
    release: () => void;
}>();
const electronApi = createElectronApi(ipcRenderer, webUtils, {waitForDocumentOpenDirect: path => deferredAutomationDocumentOpens.get(path)?.promise ?? Promise.resolve()});
contextBridge.exposeInMainWorld('electronAPI', electronApi);
tracePreload('electronAPI exposed to renderer');

if (isRendererAutomationFileOpenHelperEnabled()) {
    const invokeDocuments = createCodecIpcInvoker<IDocumentsInvokeMap>(ipcRenderer, DOCUMENTS_IPC_CODECS);
    contextBridge.exposeInMainWorld('__allowRendererFileOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const automationFileOpenToken = globalThis.crypto.randomUUID();
        return invokeDocuments(
            DOCUMENTS_CHANNELS.registerRendererFileOpenToken,
            automationFileOpenToken,
        ).then(() => invokeDocuments(DOCUMENTS_CHANNELS.allowRendererFileOpen, {
            filePath: path,
            token: automationFileOpenToken,
        }));
    });
    contextBridge.exposeInMainWorld('__deferDocumentOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        if (!path || deferredAutomationDocumentOpens.has(path)) {
            return false;
        }
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
            release = resolve;
        });
        deferredAutomationDocumentOpens.set(path, {
            promise,
            release,
        });
        return true;
    });
    contextBridge.exposeInMainWorld('__releaseDocumentOpenForAutomation', (filePath: string) => {
        const path = typeof filePath === 'string' ? filePath : '';
        const deferred = deferredAutomationDocumentOpens.get(path);
        if (!deferred) {
            return false;
        }
        deferredAutomationDocumentOpens.delete(path);
        deferred.release();
        return true;
    });
    tracePreload('automation file-open capability helper exposed');
}

installStartupOverlayLifecycle({
    tracePreload,
    forwardPreloadLogToMain,
});
