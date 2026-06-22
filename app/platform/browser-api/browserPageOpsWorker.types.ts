import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';

interface IPageMutationWorkerResult {
    data: Uint8Array;
    pageCount: number;
}

interface IBrowserPageOpsWorkerRequestMap {
    deletePages: {
        data: Uint8Array;
        pages: number[];
    };
    extractPages: {
        data: Uint8Array;
        pages: number[];
    };
    reorderPages: {
        data: Uint8Array;
        newOrder: number[];
    };
    insertPages: {
        data: Uint8Array;
        insertionData: Uint8Array;
        afterPage: number;
    };
    rotate: {
        data: Uint8Array;
        pages: number[];
        angle: 90 | 180 | 270;
    };
    crop: {
        data: Uint8Array;
        pages: number[];
        margins: ICropMargins;
    };
    removeCrop: {
        data: Uint8Array;
        pages: number[];
    };
    getPageGeometry: {
        data: Uint8Array;
        pageNumber: number;
    };
}

interface IBrowserPageOpsWorkerResultMap {
    deletePages: IPageMutationWorkerResult;
    extractPages: IPageMutationWorkerResult;
    reorderPages: IPageMutationWorkerResult;
    insertPages: IPageMutationWorkerResult;
    rotate: IPageMutationWorkerResult;
    crop: IPageMutationWorkerResult;
    removeCrop: IPageMutationWorkerResult;
    getPageGeometry: IPageGeometry;
}

type TBrowserPageOpsWorkerRequestType = keyof IBrowserPageOpsWorkerRequestMap;

interface IBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType = TBrowserPageOpsWorkerRequestType> {
    id: number;
    type: K;
    payload: IBrowserPageOpsWorkerRequestMap[K];
}

type TBrowserPageOpsWorkerRequest = {
    [K in TBrowserPageOpsWorkerRequestType]: IBrowserPageOpsWorkerRequest<K>;
}[TBrowserPageOpsWorkerRequestType];

type TBrowserPageOpsWorkerResponse =
    | {
        [K in TBrowserPageOpsWorkerRequestType]: {
            id: number;
            type: K;
            ok: true;
            data: IBrowserPageOpsWorkerResultMap[K];
        };
    }[TBrowserPageOpsWorkerRequestType]
    | {
        id: number;
        ok: false;
        error: string;
    };

function isSafeWorkerRequestId(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isPositiveIntegerArray(value: unknown): value is number[] {
    return Array.isArray(value)
        && value.every(isPositiveInteger);
}

function isCropMargins(value: unknown): value is ICropMargins {
    return isRecord(value)
        && typeof value.top === 'number'
        && typeof value.bottom === 'number'
        && typeof value.left === 'number'
        && typeof value.right === 'number'
        && Number.isFinite(value.top)
        && Number.isFinite(value.bottom)
        && Number.isFinite(value.left)
        && Number.isFinite(value.right);
}

function getPdfData(value: Record<PropertyKey, unknown>) {
    return value.data instanceof Uint8Array
        ? value.data
        : null;
}

export function getBrowserPageOpsWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPageOpsWorkerRequest(value: unknown): TBrowserPageOpsWorkerRequest | null {
    if (!isRecord(value) || !isSafeWorkerRequestId(value.id) || typeof value.type !== 'string' || !isRecord(value.payload)) {
        return null;
    }
    const data = getPdfData(value.payload);
    if (data === null) {
        return null;
    }
    switch (value.type) {
        case 'deletePages':
        case 'extractPages':
        case 'removeCrop':
            return isPositiveIntegerArray(value.payload.pages)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                    },
                }
                : null;
        case 'reorderPages':
            return isPositiveIntegerArray(value.payload.newOrder)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        newOrder: value.payload.newOrder,
                    },
                }
                : null;
        case 'insertPages':
            return value.payload.insertionData instanceof Uint8Array && isNonNegativeInteger(value.payload.afterPage)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        insertionData: value.payload.insertionData,
                        afterPage: value.payload.afterPage,
                    },
                }
                : null;
        case 'rotate':
            return isPositiveIntegerArray(value.payload.pages)
                && (
                    value.payload.angle === 90
                    || value.payload.angle === 180
                    || value.payload.angle === 270
                )
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                        angle: value.payload.angle,
                    },
                }
                : null;
        case 'crop':
            return isPositiveIntegerArray(value.payload.pages) && isCropMargins(value.payload.margins)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pages: value.payload.pages,
                        margins: value.payload.margins,
                    },
                }
                : null;
        case 'getPageGeometry':
            return isPositiveInteger(value.payload.pageNumber)
                ? {
                    id: value.id,
                    type: value.type,
                    payload: {
                        data,
                        pageNumber: value.payload.pageNumber,
                    },
                }
                : null;
        default:
            return null;
    }
}

export type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    IBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
};
