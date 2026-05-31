import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/public';
import { BrowserLogger } from '@app/utils/browserLogger';

const STARTUP_OPEN_VISUAL_READY_EVENT_NAME = 'evb:startup-open-visual-ready';
const STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS = 15_000;
const STARTUP_OPEN_VISUAL_READY_POLL_MS = 50;
const STARTUP_OPEN_VISUAL_READY_FRAME_COUNT = 2;

interface IWorkspaceStartupReadinessOptions {
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    showNativeDjvuViewer: Ref<boolean>;
}

function dispatchStartupOpenVisualReady(reason: string, timedOut = false) {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new CustomEvent(STARTUP_OPEN_VISUAL_READY_EVENT_NAME, {detail: {
        reason,
        timedOut,
    }}));
}

function waitForStartupAnimationFrame() {
    return new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function waitForStartupVisualFrames() {
    for (let index = 0; index < STARTUP_OPEN_VISUAL_READY_FRAME_COUNT; index += 1) {
        await waitForStartupAnimationFrame();
    }
}

export function useWorkspaceStartupReadiness(options: IWorkspaceStartupReadinessOptions) {
    const {
        pdfViewerRef,
        showNativeDjvuViewer,
    } = options;
    let startupOpenVisualReadyToken = 0;

    function hasRenderedStartupDocument() {
        const viewer = pdfViewerRef.value;
        const container = viewer?.getViewerContainer?.() ?? null;
        if (container?.querySelector('.page_container--rendered .page_canvas canvas')) {
            return true;
        }

        return Boolean(showNativeDjvuViewer.value)
            && Boolean(container?.querySelector('canvas, img'));
    }

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
                    const viewer = pdfViewerRef.value;
                    const waitForViewerLoadSettled = viewer?.waitForViewerLoadSettled;
                    if (typeof waitForViewerLoadSettled === 'function') {
                        const remainingMs = Math.max(0, STARTUP_OPEN_VISUAL_READY_TIMEOUT_MS - (Date.now() - startedAt));
                        let settleTimedOut = false;
                        await Promise.race([
                            waitForViewerLoadSettled.call(viewer),
                            delay(remainingMs).then(() => {
                                settleTimedOut = true;
                            }),
                        ]);

                        if (settleTimedOut) {
                            timedOut = true;
                            break;
                        }
                    }

                    await nextTick();
                    await waitForStartupVisualFrames();
                    if (hasRenderedStartupDocument()) {
                        break;
                    }

                    await delay(STARTUP_OPEN_VISUAL_READY_POLL_MS);
                }

                if (!hasRenderedStartupDocument()) {
                    timedOut = true;
                }
            } catch (error) {
                timedOut = true;
                BrowserLogger.warn('loader', 'Startup visual readiness wait failed', error);
            }

            if (token !== startupOpenVisualReadyToken) {
                return;
            }

            dispatchStartupOpenVisualReady(reason, timedOut);
        })();
    }

    return {
        scheduleStartupOpenVisualReady,
        hasRenderedStartupDocument,
        dispatchStartupOpenVisualReady,
    };
}
