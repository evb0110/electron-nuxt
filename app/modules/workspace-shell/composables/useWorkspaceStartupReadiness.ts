import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';

const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS = 15_000;
const STARTUP_OPEN_VIEWER_REF_POLL_MS = 50;

interface IWorkspaceStartupReadinessOptions {documentViewerRef: Ref<IDocumentViewerExpose | null>;}

function dispatchStartupOpenVisualReady(reason: string, timedOut = false) {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, {detail: {
        reason,
        timedOut,
    }}));
}

function createStartupTimeout(timeoutMs: number) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<'timeout'>((resolve) => {
        timeoutId = setTimeout(() => {
            timeoutId = null;
            resolve('timeout');
        }, timeoutMs);
    });

    return {
        promise,
        cancel: () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        },
    };
}

export const useWorkspaceStartupReadiness = (options: IWorkspaceStartupReadinessOptions) => {
    const { documentViewerRef } = options;
    let startupOpenVisualReadyToken = 0;

    function scheduleStartupOpenVisualReady(reason: string) {
        const token = ++startupOpenVisualReadyToken;
        void (async () => {
            const startedAt = Date.now();
            let timedOut = false;

            try {
                while (Date.now() - startedAt < STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS) {
                    if (token !== startupOpenVisualReadyToken) {
                        return;
                    }

                    await nextTick();
                    const viewer = documentViewerRef.value;
                    const waitForViewerLoadSettled = viewer?.waitForViewerLoadSettled;
                    if (typeof waitForViewerLoadSettled === 'function') {
                        const remainingMs = Math.max(0, STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS - (Date.now() - startedAt));
                        const timeout = createStartupTimeout(remainingMs);
                        let settleTimedOut = false;
                        try {
                            settleTimedOut = await Promise.race([
                                waitForViewerLoadSettled.call(viewer).then(() => false),
                                timeout.promise.then(() => true),
                            ]);
                        } finally {
                            timeout.cancel();
                        }

                        if (settleTimedOut) {
                            timedOut = true;
                        }
                        break;
                    }

                    await delay(STARTUP_OPEN_VIEWER_REF_POLL_MS);
                }

                if (!documentViewerRef.value?.waitForViewerLoadSettled) {
                    timedOut = true;
                }
            } catch (error) {
                timedOut = true;
                BrowserLogger.diagnostic('loader', 'Startup visual readiness wait failed', error);
            }

            if (token !== startupOpenVisualReadyToken) {
                return;
            }

            dispatchStartupOpenVisualReady(reason, timedOut);
        })();
    }

    return {
        scheduleStartupOpenVisualReady,
        dispatchStartupOpenVisualReady,
    };
};
