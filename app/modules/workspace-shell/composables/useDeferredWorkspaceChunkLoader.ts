import { shouldRetryAsyncChunkLoad } from '@app/modules/workspace-shell/host/shouldRetryAsyncChunkLoad';
import { BrowserLogger } from '@app/utils/browserLogger';

const ASYNC_CHUNK_RETRY_DELAY_STEP_MS = 150;

interface IUseDeferredWorkspaceChunkLoaderOptions {
    logSection: string;
    tabId: string;
}

const loadDocumentWorkspace = () => import('@app/modules/workspace-shell/components/DocumentWorkspace.vue');

export const useDeferredWorkspaceChunkLoader = (options: IUseDeferredWorkspaceChunkLoaderOptions) => {
    const workspaceChunkLoadError = ref<unknown>(null);
    const workspaceRenderNonce = ref(0);
    const chunkRetryTimers = new Set<ReturnType<typeof setTimeout>>();
    const DocumentWorkspace = import.meta.client
        ? defineAsyncComponent({
            loader: loadDocumentWorkspace,
            suspensible: false,
            onError: (error, retry, fail, attempts) => {
                BrowserLogger.error(options.logSection, 'DocumentWorkspace async chunk load failed', {
                    tabId: options.tabId,
                    attempts,
                    error,
                });

                if (shouldRetryAsyncChunkLoad({
                    attempts,
                    error,
                    isDev: import.meta.dev,
                })) {
                    const retryDelayMs = attempts * ASYNC_CHUNK_RETRY_DELAY_STEP_MS;
                    const retryTimer = setTimeout(() => {
                        chunkRetryTimers.delete(retryTimer);
                        retry();
                    }, retryDelayMs);
                    chunkRetryTimers.add(retryTimer);
                    return;
                }

                workspaceChunkLoadError.value = error;
                fail();
            },
        })
        : null;

    function resetWorkspaceChunkLoadError() {
        workspaceChunkLoadError.value = null;
    }

    function retryWorkspaceChunkRender() {
        resetWorkspaceChunkLoadError();
        workspaceRenderNonce.value += 1;
    }

    function clearWorkspaceChunkRetryTimers() {
        for (const timer of chunkRetryTimers) {
            clearTimeout(timer);
        }
        chunkRetryTimers.clear();
    }

    return {
        DocumentWorkspace,
        clearWorkspaceChunkRetryTimers,
        loadDocumentWorkspace,
        resetWorkspaceChunkLoadError,
        retryWorkspaceChunkRender,
        workspaceChunkLoadError,
        workspaceRenderNonce,
    };
};
