import { createPageRenderTimeoutError } from '@app/utils/pdf-viewer/pdf-page-render-timeout/createPageRenderTimeoutError';
import type { IPageRenderStallPayload } from '@app/utils/pdf-viewer/pdf-page-render-timeout/pdfPageRenderTimeoutTypes';

export async function withPageStageTimeout<T>(
    promise: Promise<T>,
    payload: IPageRenderStallPayload,
    shouldNotify: () => boolean,
    onTimeout?: () => void,
    onRenderStall?: (payload: IPageRenderStallPayload) => void,
) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timeoutHandle = setTimeout(() => {
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
        }, payload.timeoutMs);

        promise.then(
            (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutHandle);
                resolve(value);
            },
            (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutHandle);
                reject(error);
            },
        );
    });
}
