import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';

export type TCropWorkerInput =
    | {
        type: 'crop';
        workingCopyPath: string;
        pages: number[];
        margins: ICropMargins;
        senderWebContentsId?: number;
    }
    | {
        type: 'removeCrop';
        workingCopyPath: string;
        pages: number[];
        senderWebContentsId?: number;
    }
    | {
        type: 'getPageGeometry';
        workingCopyPath: string;
        pageNumber: number;
        senderWebContentsId?: number;
    };

export type TCropWorkerResult =
    | {
        type: 'result';
        ok: true;
        data?: IPageGeometry;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };
