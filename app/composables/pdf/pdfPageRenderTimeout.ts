export type TPageRenderStallStage = 'page-load' | 'canvas-render';

export interface IPageRenderStallPayload {
    pageNumber: number;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}

export interface IPageRenderTimeoutError extends Error {
    pageNumber: number;
    stage: TPageRenderStallStage;
    timeoutMs: number;
}

export function createPageRenderTimeoutError(
    pageNumber: number,
    stage: TPageRenderStallStage,
    timeoutMs: number,
): IPageRenderTimeoutError {
    const error = new Error(
        `Timed out waiting for ${stage} on page ${pageNumber} after ${timeoutMs}ms`,
    ) as IPageRenderTimeoutError;
    error.name = 'PdfPageRenderTimeoutError';
    error.pageNumber = pageNumber;
    error.stage = stage;
    error.timeoutMs = timeoutMs;
    return error;
}

export function isPageRenderTimeoutError(error: unknown): error is IPageRenderTimeoutError {
    return Boolean(
        error
        && typeof error === 'object'
        && 'name' in error
        && 'stage' in error
        && 'timeoutMs' in error
        && (error as { name?: unknown }).name === 'PdfPageRenderTimeoutError',
    );
}

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
