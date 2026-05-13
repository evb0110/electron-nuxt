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

export type {
    IBrowserSearchWorkerRequestMap,
    IBrowserSearchWorkerResultMap,
    IBrowserSearchWorkerRequest,
    TBrowserSearchWorkerRequestType,
    TBrowserSearchWorkerResponse,
};
