import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';

interface IPageMutationWorkerResult {
    data: Uint8Array;
    pageCount: number;
}

interface IBrowserPageOpsWorkerRequestMap {
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
    rotate: IPageMutationWorkerResult;
    crop: IPageMutationWorkerResult;
    removeCrop: IPageMutationWorkerResult;
    getPageGeometry: IPageGeometry;
}

type TBrowserPageOpsWorkerRequestType = keyof IBrowserPageOpsWorkerRequestMap;

type TBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType = TBrowserPageOpsWorkerRequestType> = {
    id: number;
    type: K;
    payload: IBrowserPageOpsWorkerRequestMap[K];
};

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
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
};
