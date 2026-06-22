import { isRecord } from '@contracts/runtimeGuards';

interface IBrowserSearchWorkerRequestMap {
    extractDocumentText: {pdfPath: string;};
    cancel: {requestId: number;};
}

interface IBrowserSearchWorkerResultMap {
    extractDocumentText: {
        pageCount: number;
        pageTexts: string[];
    };
    cancel: {canceled: boolean;};
}

type TBrowserSearchWorkerRequestType = keyof IBrowserSearchWorkerRequestMap;

interface IBrowserSearchWorkerRequest<K extends TBrowserSearchWorkerRequestType = TBrowserSearchWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserSearchWorkerRequestMap[K];
}

type TBrowserSearchWorkerRequest = {
    [K in TBrowserSearchWorkerRequestType]: IBrowserSearchWorkerRequest<K>;
}[TBrowserSearchWorkerRequestType];

type TBrowserSearchWorkerProgressResponse = {
    [K in TBrowserSearchWorkerRequestType]: {
        id: number;
        type: K;
        ok: true;
        progress: {
            processed: number;
            total: number;
        };
    };
}[TBrowserSearchWorkerRequestType];

type TBrowserSearchWorkerSuccessResponse = {
    [K in TBrowserSearchWorkerRequestType]: {
        id: number;
        type: K;
        ok: true;
        data: IBrowserSearchWorkerResultMap[K];
    };
}[TBrowserSearchWorkerRequestType];

interface IBrowserSearchWorkerErrorResponse {
    id: number;
    ok: false;
    error: string;
}

type TBrowserSearchWorkerResponse =
    | TBrowserSearchWorkerProgressResponse
    | TBrowserSearchWorkerSuccessResponse
    | IBrowserSearchWorkerErrorResponse;

function isSafeWorkerRequestId(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function parseExtractDocumentTextPayload(value: unknown): IBrowserSearchWorkerRequestMap['extractDocumentText'] | null {
    if (!isRecord(value) || typeof value.pdfPath !== 'string' || value.pdfPath.trim().length === 0) {
        return null;
    }
    return {pdfPath: value.pdfPath};
}

function parseCancelPayload(value: unknown): IBrowserSearchWorkerRequestMap['cancel'] | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.requestId)) {
        return null;
    }
    return {requestId: value.requestId};
}

export function getBrowserSearchWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserSearchWorkerRequest(value: unknown): TBrowserSearchWorkerRequest | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.id) || typeof value.type !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'extractDocumentText': {
            const payload = parseExtractDocumentTextPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        case 'cancel': {
            const payload = parseCancelPayload(value.payload);
            return payload === null
                ? null
                : {
                    id: value.id,
                    type: value.type,
                    payload,
                };
        }
        default:
            return null;
    }
}

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
};
