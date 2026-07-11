import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export type TPageOpsRotationAngle = 90 | 180 | 270;

export interface IPageOpsMetadataSnapshot {
    pageLabels: string[] | null;
    bookmarks: IPdfBookmarkEntry[];
    untitledBookmarkLabel: string;
}

export interface IPageOpsMutationOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
}

export interface IPageIdentityDelta {
    previousPageCount: number;
    pages: Array<{fromPageNumber: number} | {insertedId: string}>;
}

export interface IPageOpsResult {
    success: boolean;
    pageCount?: number;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}

export interface IPageOpsExtractResult {
    success: boolean;
    canceled?: boolean;
    destPath?: TDocumentRef;
}

export interface IPageOpsInsertResult {
    success: boolean;
    canceled?: boolean;
    documentRevision?: IDocumentRevisionInfo;
    pageIdentityDelta?: IPageIdentityDelta;
}

export interface IPageOpsCapability {
    delete: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number, options?: IPageOpsMutationOptions) => Promise<IPageOpsResult>;
    extract: (workingCopyPath: TDocumentRef, pages: number[]) => Promise<IPageOpsExtractResult>;
    reorder: (workingCopyPath: TDocumentRef, newOrder: number[], options?: IPageOpsMutationOptions) => Promise<IPageOpsResult>;
    insert: (workingCopyPath: TDocumentRef, totalPages: number, afterPage: number, options?: IPageOpsMutationOptions) => Promise<IPageOpsInsertResult>;
    insertFile: (
        workingCopyPath: TDocumentRef,
        totalPages: number,
        afterPage: number,
        sourcePaths: TDocumentRef[],
        requestId?: string,
        options?: IPageOpsMutationOptions,
    ) => Promise<IPageOpsResult>;
    rotate: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number, angle: TPageOpsRotationAngle, options?: IPageOpsMutationOptions) => Promise<IPageOpsResult>;
    crop: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number, margins: ICropMargins, options?: IPageOpsMutationOptions) => Promise<IPageOpsResult>;
    removeCrop: (workingCopyPath: TDocumentRef, pages: number[], totalPages: number, options?: IPageOpsMutationOptions) => Promise<IPageOpsResult>;
    getPageGeometry: (workingCopyPath: TDocumentRef, pageNumber: number) => Promise<IPageGeometry>;
}
