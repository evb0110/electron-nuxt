import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';

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

export type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    IBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
};
