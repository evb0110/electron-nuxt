import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';

interface IBrowserPdfCombineInput {
    fileName: string;
    data: Uint8Array;
}

interface IBrowserPdfCombineWorkerRequestMap {combinePdfs: {inputs: IBrowserPdfCombineInput[];};}

interface IBrowserPdfCombineWorkerResultMap {combinePdfs: {data: Uint8Array;};}

type TBrowserPdfCombineWorkerRequestType = keyof IBrowserPdfCombineWorkerRequestMap;

interface IBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType = TBrowserPdfCombineWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserPdfCombineWorkerRequestMap[K];
}

type TBrowserPdfCombineWorkerRequest = {
    [K in TBrowserPdfCombineWorkerRequestType]: IBrowserPdfCombineWorkerRequest<K>;
}[TBrowserPdfCombineWorkerRequestType];

type TBrowserPdfCombineWorkerResponse =
    | {
        [K in TBrowserPdfCombineWorkerRequestType]: {
            id: number;
            type: K;
            ok: true;
            data: IBrowserPdfCombineWorkerResultMap[K];
        };
    }[TBrowserPdfCombineWorkerRequestType]
    | {
        id: number;
        ok: false;
        error: string;
    };


function parseBrowserPdfCombineInput(value: unknown): IBrowserPdfCombineInput | null {
    if (
        !isRecord(value)
        || typeof value.fileName !== 'string'
        || value.fileName.trim().length === 0
        || !(value.data instanceof Uint8Array)
    ) {
        return null;
    }
    return {
        fileName: value.fileName,
        data: value.data,
    };
}

export function getBrowserPdfCombineWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPdfCombineWorkerRequest(value: unknown): TBrowserPdfCombineWorkerRequest | null {
    if (
        !isRecord(value)
        || !isSafeWorkerRequestId(value.id)
        || value.type !== 'combinePdfs'
        || !isRecord(value.payload)
        || !Array.isArray(value.payload.inputs)
    ) {
        return null;
    }
    const inputs: IBrowserPdfCombineInput[] = [];
    for (const input of value.payload.inputs) {
        const parsedInput = parseBrowserPdfCombineInput(input);
        if (parsedInput === null) {
            return null;
        }
        inputs.push(parsedInput);
    }
    return {
        id: value.id,
        type: value.type,
        payload: {inputs},
    };
}

export type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    IBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
};
