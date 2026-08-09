import { isRecord } from '@contracts/runtimeGuards';
import {
    isSerializableErrorEnvelope,
    SerializableError,
    type ISerializableErrorEnvelope,
} from '@contracts/serializableError';

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
        errorEnvelope?: ISerializableErrorEnvelope;
    };

type TSerializableErrorEnvelopeGuard = (
    value: unknown,
) => value is ISerializableErrorEnvelope;

function getWorkerResponseId(response: unknown) {
    return isRecord(response) && typeof response.id === 'number'
        ? response.id
        : null;
}

function parseBrowserWorkerResult(
    response: unknown,
    expectedType: string,
    isErrorEnvelope: TSerializableErrorEnvelopeGuard,
): TBrowserWorkerResult | null {
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

    if (
        response.ok === false
        && typeof response.error === 'string'
        && (response.errorEnvelope === undefined || isErrorEnvelope(response.errorEnvelope))
    ) {
        return {
            id: response.id,
            ok: false,
            error: response.error,
            ...(response.errorEnvelope === undefined ? {} : {errorEnvelope: response.errorEnvelope}),
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
    isErrorEnvelope: TSerializableErrorEnvelopeGuard = isSerializableErrorEnvelope,
) {
    const responseId = getWorkerResponseId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingRequests.get(responseId);
    if (!pending) {
        return;
    }

    const result = parseBrowserWorkerResult(response, pending.requestType, isErrorEnvelope);

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

    pending.reject(result.errorEnvelope
        ? new SerializableError(result.errorEnvelope)
        : new Error(result.error));
    onSettled();
}
