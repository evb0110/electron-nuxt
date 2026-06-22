import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import type { IWorkerTaskErrorFrame } from '@electron/utils/workerTask';

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

export interface ICropWorkerCancelMessage {type: 'cancel';}

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
        errorFrame?: IWorkerTaskErrorFrame;
    };
