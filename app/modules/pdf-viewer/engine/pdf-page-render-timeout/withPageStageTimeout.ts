import { createPageRenderTimeoutError } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/createPageRenderTimeoutError';
import type { IPageRenderStallPayload } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

const defaultPdfPageStageRenderSupervisor = createPdfRenderSupervisor();
let pageStageTimeoutSequence = 0;

export async function withPageStageTimeout<T>(
    promise: Promise<T>,
    payload: IPageRenderStallPayload,
    shouldNotify: () => boolean,
    onTimeout?: () => void,
    onRenderStall?: (payload: IPageRenderStallPayload) => void,
    renderSupervisor: IPdfRenderSupervisor = defaultPdfPageStageRenderSupervisor,
    signal?: AbortSignal,
) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const createAbortError = () => {
            const error = new Error('Page render stage was aborted');
            error.name = 'AbortError';
            return error;
        };
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        pageStageTimeoutSequence += 1;
        const timeoutHandle = renderSupervisor.armTimer({
            cause: 'page-stage-timeout',
            delayMs: payload.timeoutMs,
            key: `page-stage-timeout:${payload.pageNumber}:${payload.stage}:${pageStageTimeoutSequence}`,
            metadata: {
                pageNumber: payload.pageNumber,
                stage: payload.stage,
                timeoutMs: payload.timeoutMs,
            },
            onFire: () => {
                if (settled) {
                    return;
                }
                settled = true;
                signal?.removeEventListener('abort', handleAbort);
                onTimeout?.();
                if (shouldNotify()) {
                    onRenderStall?.(payload);
                }
                reject(
                    createPageRenderTimeoutError(
                        payload.pageNumber,
                        payload.stage,
                        payload.timeoutMs,
                    ),
                );
            },
        });
        const handleAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            timeoutHandle.clear();
            signal?.removeEventListener('abort', handleAbort);
            reject(createAbortError());
        };
        signal?.addEventListener('abort', handleAbort, {once: true});

        promise.then(
            (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                timeoutHandle.clear();
                signal?.removeEventListener('abort', handleAbort);
                resolve(value);
            },
            (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                timeoutHandle.clear();
                signal?.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
    });
}
