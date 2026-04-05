interface IBrowserPdfCombineInput {
    fileName: string;
    data: Uint8Array;
}

interface IBrowserPdfCombineWorkerRequestMap {combinePdfs: {inputs: IBrowserPdfCombineInput[];};}

interface IBrowserPdfCombineWorkerResultMap {combinePdfs: {data: Uint8Array;};}

type TBrowserPdfCombineWorkerRequestType = keyof IBrowserPdfCombineWorkerRequestMap;

type TBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType = TBrowserPdfCombineWorkerRequestType> = {
    id: number;
    type: K;
    payload: IBrowserPdfCombineWorkerRequestMap[K];
};

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

export type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
};
