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
) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
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

        promise.then(
            (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                timeoutHandle.clear();
                resolve(value);
            },
            (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                timeoutHandle.clear();
                reject(error);
            },
        );
    });
}
