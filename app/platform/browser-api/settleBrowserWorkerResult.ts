import { isRecord } from '@contracts/runtimeGuards';

export interface IPendingBrowserWorkerRequest {
    requestType: string;
    resolveData: (data: unknown) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

export interface ITypedPendingBrowserWorkerRequest<
    TRequestType extends string,
    TResultData,
> {
    requestType: TRequestType;
    resolveData: (data: TResultData) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

type TBrowserWorkerResult<TData = unknown> =
    | {
        id: number;
        ok: true;
        data: TData;
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

function getWorkerResponseId(response: unknown) {
    return isRecord(response) && typeof response.id === 'number'
        ? response.id
        : null;
}

function parseBrowserWorkerResult(
    response: unknown,
    expectedType: string,
): TBrowserWorkerResult<unknown> | null {
    if (!isRecord(response) || typeof response.id !== 'number') {
        return null;
    }

    if (response.ok === true) {
        if (response.type !== expectedType || !('data' in response)) {
            return null;
        }
        return {
            id: response.id,
            ok: true,
            data: response.data,
        };
    }

    if (response.ok === false && typeof response.error === 'string') {
        return {
            id: response.id,
            ok: false,
            error: response.error,
        };
    }

    return null;
}

export function settleBrowserWorkerResult<
    TRequestType extends string,
    TResultData,
    TPendingRequest extends ITypedPendingBrowserWorkerRequest<TRequestType, TResultData>,
>(
    pendingRequests: Map<number, TPendingRequest>,
    response: unknown,
    onSettled: () => void,
) {
    const responseId = getWorkerResponseId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingRequests.get(responseId);
    if (!pending) {
        return;
    }

    const result = parseBrowserWorkerResult(response, pending.requestType);

    pendingRequests.delete(responseId);
    if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
    }
    if (!result) {
        pending.reject(new Error('Browser worker returned an invalid response'));
        onSettled();
        return;
    }
    if (result.ok) {
        if (!pending.resolveData(result.data as TResultData)) {
            pending.reject(new Error('Browser worker returned an invalid result'));
            onSettled();
            return;
        }
        onSettled();
        return;
    }

    pending.reject(new Error(result.error));
    onSettled();
}
