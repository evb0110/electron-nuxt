import type { TDocumentRef } from '@contracts/documentRef';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';

export type TPageOpsRotationAngle = 90 | 180 | 270;

export interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
}

export interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: TDocumentRef;
}

export interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
}

export interface IPageOpsCapability {
    delete: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: TDocumentRef, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: TDocumentRef, newOrder: number[]) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: TDocumentRef, totalPages: number, afterPage: number) => Promise<IPageOpsInsertResult>;
    insertFile: (
        workingCopyPath: TDocumentRef,
        totalPages: number,
        afterPage: number,
        sourcePaths: TDocumentRef[],
        requestId?: string,
    ) => Promise<IPageOpsResult>;
    rotate: (workingCopyPath: TDocumentRef, pages: number[], angle: TPageOpsRotationAngle) => Promise<IPageOpsResult>;
    crop: (workingCopyPath: TDocumentRef, pages: number[], margins: ICropMargins) => Promise<IPageOpsResult>;
    removeCrop: (workingCopyPath: TDocumentRef, pages: number[]) => Promise<IPageOpsResult>;
    getPageGeometry: (workingCopyPath: TDocumentRef, pageNumber: number) => Promise<IPageGeometry>;
}
